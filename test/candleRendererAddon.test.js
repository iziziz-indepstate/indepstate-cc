const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readOnlyAdapter, StdioAdapter } = require('../app/services/candleLevelRenderer/transport');
const { chart, localDebugger } = require('../app/services/candleLevelRenderer/reader');
const { startReader } = require('../app/services/candleLevelRenderer/reader');
const { attach } = require('../app/services/candleLevelRenderer');

test('existing adapter facade exposes candle requests without trading methods', async () => {
  const calls = [];
  const raw = { capabilities: ['candle-levels'], health: async () => ({}),
    candleSymbol: value => value, request: async (...args) => { calls.push(args); return { candleLevels: {} }; },
    place() { throw Error('trading must be unreachable'); } };
  const adapter = readOnlyAdapter(raw);
  await adapter.request('/candle-levels', { action: 'delete' });
  assert.throws(() => adapter.request('/place', {}));
  assert.equal(calls.length, 1); assert.equal(adapter.place, undefined);
  assert.deepEqual(adapter.capabilities, ['candle-levels']);
});

test('local chart discovery excludes other websites and remote debug endpoints', () => {
  assert.ok(chart('https://www.tradingview.com/chart/'));
  assert.ok(chart('https://ru.tradingview.com/chart/demo/'));
  assert.equal(chart('https://tradingview.com.attacker.invalid/chart/'), false);
  assert.equal(chart('https://user@tradingview.com/chart/'), false);
  assert.ok(localDebugger('ws://127.0.0.1:9222/devtools/page/one'));
  assert.equal(localDebugger('ws://203.0.113.1:9222/devtools/page/one'), false);
  assert.equal(localDebugger('ws://127.0.0.1:9223/devtools/page/one'), false);
});

function processFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false; child.kill = () => { child.killed = true; };
  let invocation, input = '';
  child.stdin.on('data', bytes => { input += bytes; });
  const adapter = new StdioAdapter(['python', 'reader.py', '--config', 'private-config.json'], {
    spawnProcess(...args) { invocation = args; return child; }
  });
  return { child, adapter, invocation, input: () => input,
    reply(value) { child.stdout.write(JSON.stringify(value) + '\n'); } };
}

test('stdio transport uses literal arguments, validates capabilities and correlates replies', async () => {
  const fixture = processFixture();
  assert.equal(fixture.invocation[2].shell, false);
  const health = fixture.adapter.health();
  const request = JSON.parse(fixture.input().trim());
  assert.equal(request.route, '/health');
  fixture.reply({ id: request.id, result: { capabilities: ['candle-levels', 'candle-levels-color', 'trade'] } });
  await health;
  assert.deepEqual(fixture.adapter.capabilities, ['candle-levels', 'candle-levels-color']);
  await assert.rejects(fixture.adapter.request('/place', {}));
  fixture.adapter.close();
});

test('stdio invalid JSON or stopped receiver rejects pending work', async () => {
  const fixture = processFixture();
  const pending = fixture.adapter.health();
  fixture.child.stdout.write('null\n');
  await assert.rejects(pending);
  assert.equal(fixture.child.killed, true);
});

test('stdio never constructs a shell command from downloaded plan data', () => {
  for (const command of [[], 'python reader.py', ['python', 'bad\nargument'], [null]]) {
    assert.throws(() => new StdioAdapter(command));
  }
});

test('shipped settings start disabled with no recipient mappings or commands', () => {
  const config = require('../app/services/candleLevelRenderer/config/candle-renderer.json');
  assert.equal(config.enabled, false);
  assert.deepEqual(config.mappings, []);
  assert.deepEqual(config.readerCommand, []);
  assert.deepEqual(require('../app/services/candleLevelRenderer/candle-mappings').sourceMap(), {});
});

test('disabled addon consumes no drawings and does not access the broker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candle-addon-test-'));
  let reads = 0, stopped = false, registration;
  const servicesApi = { mt5VPS: { getAdapter() { reads++; throw Error('disabled'); } } };
  const config = { enabled: false, mappings: [], adapterMode: 'iscc', publishToLT: true };
  const settings = { register(...args) { registration = args; }, readConfig: () => ({ config }), onApply() {} };
  const renderer = attach({ servicesApi, root, settings,
    createReader() { return { refresh() {}, stop() { stopped = true; } }; } });
  try {
    assert.equal(renderer.acceptSource('manual', {}), false);
    assert.equal(renderer.status().enabled, false);
    assert.equal(reads, 0);
    assert.equal(attach({ servicesApi, root, settings }), renderer);
    assert.ok(registration[1].endsWith('candle-renderer.json'));
  } finally { renderer.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  assert.equal(stopped, true);
});

test('source state corruption is preserved instead of silently clearing saved levels', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candle-addon-test-'));
  fs.writeFileSync(path.join(root, 'candle-level-renderer-state.json'), 'invalid-state');
  const settings = { register() {}, readConfig: () => ({ config: {} }) };
  try { assert.throws(() => attach({ servicesApi: {}, root, settings }), /состояние/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function readerHarness(overrides={}) {
  const timers = new Map(), expressions = [], snapshots = [], errors = [];
  let sequence = 0;
  const reader = startReader({ enabled: () => true, sources: () => [], anchors: () => [],
    acceptSnapshot: value => snapshots.push(value), onError: error => errors.push(error.message),
    getTargets: async () => [{id:'one',webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/one'}],
    run: async (_url, expression) => {
      expressions.push(expression);
      return expressions.length===1 ? {sources:[],series:[],token:'one:1'} : {unchanged:true,token:'one:1'};
    },
    setTimer(fn,delay) { const id=++sequence;timers.set(id,{fn,delay});return id; },
    clearTimer(id) { timers.delete(id); },...overrides });
  return {reader,expressions,snapshots,errors,timers,async next(){
    const [id,timer]=timers.entries().next().value;timers.delete(id);await timer.fn();
  }};
}

test('warm page reads keep ten-second cadence and avoid resending collector source', async () => {
  const fixture=readerHarness();
  try {
    await fixture.next();await fixture.next();
    assert.ok(fixture.expressions[0].length>5000);
    assert.ok(fixture.expressions[1].length<1200);
    assert.equal(fixture.snapshots.length,1);
    assert.equal([...fixture.timers.values()][0].delay,10000);
  } finally {fixture.reader.stop();}
});

test('disabled page reader never accesses TradingView', async () => {
  let discoveries=0;
  const fixture=readerHarness({enabled:()=>false,getTargets:async()=>{discoveries++;return [];}});
  try {await fixture.next();assert.equal(discoveries,0);assert.equal(fixture.expressions.length,0);}
  finally {fixture.reader.stop();}
});

test('a failed chart does not block later chart snapshots', async () => {
  const fixture=readerHarness({getTargets:async()=>[{id:'bad'},{id:'good'}],run:async(_url,expression)=>{
    if(expression.includes('collect: (')) {
      if(!fixture.tried){fixture.tried=true;throw Error('one chart unavailable');}
    }
    return {sources:[],series:[],token:'good:1'};
  }});
  try {await fixture.next();assert.equal(fixture.errors.length,1);assert.equal(fixture.snapshots.length,1);}
  finally {fixture.reader.stop();}
});
