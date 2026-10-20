const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../app/services/candleLevelRenderer/candleLevels');
const { selectExtreme, timeframe, colorRgb, updateManagedLevels, OWNER, GROUP_KEYS } = core;
// Explicit synthetic mappings for these tests; shipped configuration is empty.
const mappings = [
  {enabled:true,sourceSymbol:'CAPITALCOM:NAS100',mt5Symbol:'USTEC'},
  {enabled:true,sourceSymbol:'SPREADEX:SPX',mt5Symbol:'SPX500'},
  {enabled:true,sourceSymbol:'CAPITALCOM:US500',mt5Symbol:'SPX500'}
];
class CandleLevelSync extends core.CandleLevelSync {
  constructor(options={}) { super({getConfig:()=>({mappings}),...options}); }
}
const drawing = (id, source, config={mappings}) => core.drawing(id, source, config);
const { snapshotCandlePage, candleWindowReader } = require('../app/services/candleLevelRenderer/page');

const TIME = 1791981720;
test('saved chart snapshot imports an old colored D1 line from exact loaded bars', async () => {
  const f = fixture();
  const source = shape(30368.7, '1D');
  source.serverUpdateTime = 100;
  source.state.state = { linecolor: '#2962FF', interval: '1' };
  f.sync.acceptSnapshot({ sources: [['old-day', source]], series: [{ event: 'candle_bars',
    symbol: source.symbol, interval: '1D', bars: [[TIME, 30368.7, 30340]], windows: [[TIME, TIME + 86400]] }] });
  await f.sync.tick();
  const request = f.calls.find(c => c.payload?.action === 'upsert').payload;
  assert.equal(request.timeframe, 'D1'); assert.equal(request.side, 'high');
  assert.equal(request.colorRgb, 0x2962ff);
  const count = f.calls.length;
  f.sync.acceptSnapshot({ sources: [['old-day', source]], series: [] });
  await f.sync.tick(); assert.equal(f.calls.length, count);
});

test('a page read captured before a local drag cannot undo that drag or imply deletions', () => {
  const f = fixture();
  const previous = { ...shape(), serverUpdateTime: 100 };
  f.sync.acceptSnapshot({ sources: [['one', previous]], series: [] });
  const moved = shape(30340, '5'); moved.serverUpdateTime = 100;
  f.sync.acceptSource('one', moved, { local: true });
  f.sync.acceptSnapshot({ sources: [['one', previous]], series: [] });
  assert.equal(f.sync.records.get('one').timeframe, 'M5');
  assert.equal(f.sync.records.get('one').sourcePrice, 30340);
  f.sync.acceptSnapshot({ sources: [], series: [] });
  assert.equal(f.sync.records.get('one').removed, false);
});

test('page extractor reads saved point interval and bars without calling any chart mutations', () => {
  const source = shape(30368.7, '5'); source.state.state = { symbol: source.symbol, interval: '1', linecolor: '#673AB7' };
  const values = [[TIME, 30360, 30368.7, 30340, 30350]];
  const main = { symbol: () => source.symbol, interval: () => '1', isLoading: () => false,
    bars: () => ({ firstIndex: () => 0, lastIndex: () => 0, valueAt: i => values[i] }) };
  const good = { id: () => 'old', serverUpdateTime: () => 100, state: () => source.state };
  const unsaved = { serverUpdateTime: () => 0, state: () => { throw Error('unsaved must be skipped'); } };
  const model = { mainSeries: () => main, dataSources: () => [good, unsaved, { state: () => { throw Error('study must be skipped'); } }] };
  global.window = { _exposed_chartWidgetCollection: { getAll: () => [{ model: () => model }] } };
  try {
    const snapshot = snapshotCandlePage();
    assert.equal(snapshot.sources.length, 1);
    assert.equal(snapshot.sources[0][1].state.points[0].interval, '5');
    assert.deepEqual(snapshot.series[0].bars, [[TIME, 30368.7, 30340]]);
  } finally { delete global.window; }
});

test('automatic import ignores read-only reference layouts entirely', () => {
  global.window = { _exposed_chartWidgetCollection: { readOnly: () => true,
    getAll: () => { throw Error('reference drawings must not be imported'); } } };
  try { assert.deepEqual(snapshotCandlePage(), { sources: [], series: [] }); }
  finally { delete global.window; }
});

test('color-only migration after restart retains a known side without reloading historical TV bars', async () => {
  const previous = fixture(); previous.bars(); previous.sync.acceptSource('one', shape()); await previous.sync.tick();
  const f = fixture({ initial: previous.sync.serialize() });
  const recolored = shape(); recolored.state.state = { linecolor: '#2962FF' };
  f.sync.acceptSource('one', recolored, { local: true }); await f.sync.tick();
  const payload = f.calls.find(row => row.payload?.action === 'upsert').payload;
  assert.equal(payload.side, 'high'); assert.equal(payload.colorRgb, 0x2962ff);
  assert.equal(f.sync.records.get('one').phase, 'ready');
});

test('an invalid original anchor remains an error after restart', () => {
  const f = fixture(); const invalid = shape(); invalid.state.points[0].offset = 1;
  f.sync.acceptSource('bad-anchor', invalid);
  const restored = fixture({ initial: f.sync.serialize() });
  assert.equal(restored.sync.records.get('bad-anchor').phase, 'error');
  assert.equal(restored.sync.status().errors, 1);
});

function shape(price = 30368.7, interval = '1', symbol = 'CAPITALCOM:NAS100', type = 'LineToolHorzLine') {
  return { symbol, state: { type, points: [{ time_t: TIME, offset: 0, price, interval }] } };
}
function fixture(options = {}) {
  const calls = [], saved = [], published = []; let now = TIME * 1000 + 86400000;
  let response = [], rendering = options.rendering !== false;
  const adapter = { capabilities: ['candle-levels', 'candle-levels-color', 'candle-levels-window'], brokerSymbol: symbol => symbol,
    request: async (route, payload) => {
      calls.push({ route, payload });
      if (payload?.action === 'upsert') response = [{ ...payload, price: 30380.25, status: 'drawing' }];
      else if (payload?.action === 'delete') response = response.filter(row => row.id !== payload.id);
      return { candleLevels: { levels: response.map(row => ({ ...row, status: !payload && rendering ? 'ready' : row.status })) } };
    } };
  const sync = new CandleLevelSync({ getAdapter: () => adapter, clock: () => now,
    persist: async value => saved.push(value), publish: async value => published.push(value), ...options });
  return { sync, calls, saved, published, adapter, render(value) { rendering = value; },
    advance(ms) { now += ms; }, bars(high = 30368.7, low = 30340, interval = '1') {
      const duration = { '1D': 86400, '240': 14400 }[interval] || Number(interval) * 60;
      sync.acceptBars({ event: 'candle_bars', symbol: 'CAPITALCOM:NAS100', interval, bars: [[TIME, high, low]], windows: [[TIME, TIME + duration]] });
    } };
}

test('horizontal line retains original point time/interval, independently of current chart', () => {
  const marker = drawing('ToeFAk', shape(30368.7, '240'));
  assert.equal(marker.time, TIME); assert.equal(marker.timeframe, 'H4'); assert.equal(marker.symbol, 'USTEC');
  assert.equal(marker.tool, 'line'); assert.equal(timeframe('1D'), 'D1');
  assert.equal(drawing('spx', shape(7000, '5', 'SPREADEX:SPX')).symbol, 'SPX500');
  assert.equal(drawing('qqq', shape(700, '5', 'NASDAQ:QQQ')), null);
  assert.throws(() => drawing('future', { ...shape(), state: { ...shape().state, points: [{ ...shape().state.points[0], offset: 1 }] } }), /привязки/);
});

test('one High or one Low is selected; interior prices and flat candles are rejected', () => {
  assert.equal(selectExtreme(drawing('h', shape(30368.7)), [TIME, 30368.7, 30340]), 'high');
  assert.equal(selectExtreme(drawing('l', shape(30340)), [TIME, 30368.7, 30340]), 'low');
  assert.throws(() => selectExtreme(drawing('x', shape(30350)), [TIME, 30368.7, 30340]), /точно/);
  assert.throws(() => selectExtreme(drawing('x', shape(30350)), [TIME, 30350, 30350]), /неоднозначна/);
});

test('only acknowledged MT5 price is published, never the source TV price', async () => {
  const f = fixture(); f.bars();
  assert.equal(f.sync.acceptSource('ToeFAk', shape()), true);
  await f.sync.tick();
  assert.equal(f.calls.filter(row => row.payload?.action === 'upsert').length, 1);
  const request = f.calls.find(row => row.payload?.action === 'upsert').payload;
  assert.equal(request.side, 'high'); assert.equal(request.symbol, 'USTEC');
  assert.equal(request.time, TIME); assert.equal(request.timeframe, 'M1');
  assert.equal(request.sourcePrice, undefined);
  assert.deepEqual(f.published.at(-1), { USTEC: [30380.25] });
  assert.equal(f.sync.status().ready, 1);
});

test('missing indicator acknowledgement keeps level out of LT', async () => {
  const f = fixture({ rendering: false }); f.bars(); f.sync.acceptSource('one', shape());
  await f.sync.tick();
  assert.deepEqual(f.published.at(-1), { USTEC: [] }); assert.equal(f.sync.status().ready, 0);
  f.render(true); await f.sync.tick();
  assert.deepEqual(f.published.at(-1), { USTEC: [30380.25] });
});

test('bar data may arrive after the line; selection still uses original timeframe', async () => {
  const f = fixture(); f.sync.acceptSource('one', shape(30340, '240'));
  await f.sync.tick(); assert.equal(f.calls.length, 0);
  f.bars(30368.7, 30340, '1'); await f.sync.tick(); assert.equal(f.calls.length, 0);
  f.bars(30368.7, 30340, '240'); await f.sync.tick();
  const payload = f.calls.find(row => row.payload?.action === 'upsert').payload;
  assert.equal(payload.timeframe, 'H4'); assert.equal(payload.side, 'low');
});

test('source edits during an outstanding request cannot publish an old response', async () => {
  const f = fixture(); f.bars(); f.sync.acceptSource('one', shape());
  let finish, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.adapter.request = async (_route, payload) => {
    if (!payload) return { candleLevels: { levels: [] } };
    started(); await new Promise(resolve => { finish = resolve; });
    return { candleLevels: { levels: [{ ...payload, price: 30380.25, status: 'ready' }] } };
  };
  const tick = f.sync.tick(); await entered;
  f.sync.acceptSource('one', null); finish(); await tick;
  assert.ok(f.published.every(row => !(row.USTEC || []).includes(30380.25)));
});

test('repeated source snapshots do not duplicate requests or levels; deleting retires owned level', async () => {
  const f = fixture(); f.bars(); f.sync.acceptSource('one', shape()); await f.sync.tick();
  const count = f.calls.length;
  f.sync.acceptSource('one', shape()); await f.sync.tick(); assert.equal(f.calls.length, count);
  f.sync.acceptSource('one', null); await f.sync.tick();
  assert.deepEqual(f.published.at(-1), { USTEC: [] });
  assert.equal(f.calls.at(-1).payload.action, 'delete');
});

test('failed durable state save does not send requests or mutate LT', async () => {
  const f = fixture({ persist: async () => { throw Error('disk full'); } });
  f.bars(); f.sync.acceptSource('one', shape()); await f.sync.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.published.length, 0);
  assert.equal(f.sync.status().reason, 'disk full');
});

test('disabled feature leaves normal line handling available and makes no requests', async () => {
  const f = fixture({ getConfig: () => ({ enabled: false }) }); f.bars();
  assert.equal(f.sync.acceptSource('one', shape()), false); await f.sync.tick(); assert.equal(f.calls.length, 0);
});

test('equal prices from different drawings survive removal of just one source', async () => {
  const f = fixture(); f.bars();
  f.sync.acceptSource('one', shape()); await f.sync.tick();
  f.sync.acceptSource('two', shape()); await f.sync.tick();
  assert.deepEqual(f.published.at(-1), { USTEC: [30380.25] });
  f.sync.acceptSource('one', null); await f.sync.tick();
  assert.deepEqual(f.published.at(-1), { USTEC: [30380.25] });
});

test('group ownership preserves manual groups even when the display name collides', () => {
  const manual = {key: GROUP_KEYS.USTEC, ticker:'USTEC', levels:[1,2], enabled:false, maxOffset:50};
  const config = {groups:[manual], refreshMs:1000};
  const next = updateManagedLevels(config, {USTEC:[12]});
  assert.deepEqual(next.groups[0], manual);
  assert.notEqual(next.groups[1].key, manual.key); assert.equal(next.groups[1].source, OWNER);
  next.groups[1].enabled = false; next.groups[1].maxOffset = 77;
  const cleared = updateManagedLevels(next, {USTEC:[]});
  assert.deepEqual(cleared.groups[0], manual); assert.deepEqual(cleared.groups[1].levels, []);
  assert.equal(cleared.groups[1].enabled, false); assert.equal(cleared.groups[1].maxOffset, 77);
  assert.deepEqual(config.groups, [manual]);
});

test('queued publication obtains fresh levels after a source deletion', async () => {
  const f=fixture(); f.bars(); f.sync.acceptSource('one',shape()); await f.sync.tick();
  let resume, entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const applied=[];
  f.sync.publish=async (_snapshot,latest)=>{entered();await new Promise(resolve=>{resume=resolve;});applied.push(latest());};
  f.sync.publishNeeded=true;
  const pending=f.sync.publishCurrent(); await started;
  f.sync.acceptSource('one',null); resume(); await pending;
  assert.deepEqual(applied,[{USTEC:[]}]); assert.equal(f.sync.publishNeeded,true);
});

test('history retries honor server backoff without spamming the terminal', async () => {
  const f=fixture(); f.bars(); f.sync.acceptSource('one',shape());
  f.adapter.request=async (_route,payload)=>{
    f.calls.push({payload});
    return {candleLevels:{levels:[{...payload,status:'waiting-history',retryAt:TIME*1000+86400000+10000}]}};
  };
  await f.sync.tick(); assert.equal(f.calls.length,1);
  await f.sync.tick(); assert.equal(f.calls.length,1);
  f.advance(11000); await f.sync.tick(); assert.equal(f.calls.length,2);
  assert.deepEqual(f.published.at(-1),{USTEC:[]});
});

test('an unavailable or older receiver is retried with bounded backoff', async () => {
  const f=fixture(); f.bars(); f.sync.acceptSource('one',shape());
  let checks=0;
  f.adapter.capabilities=[]; f.adapter.health=async()=>{checks++;};
  await f.sync.tick(); await f.sync.tick(); assert.equal(checks,1);
  f.advance(2001); await f.sync.tick(); assert.equal(checks,2);
  assert.match(f.sync.status().reason,/обновить/); assert.equal(f.calls.length,0);
  f.adapter.capabilities=['candle-levels','candle-levels-window'];f.advance(4001);await f.sync.tick();
  assert.equal(f.sync.status().ready,1);
});

function colored(price = 30368.7, interval = '1', color = '#2962ff', time = TIME) {
  const value = shape(price, interval);
  value.state.state = { linecolor: color, interval };
  value.state.points[0].time_t = time;
  return value;
}

test('TV blue, white, purple and red are preserved as RGB without choosing a timeframe', () => {
  for (const [css, rgb] of [['rgba(41, 98, 255, 1)', 0x2962ff], ['#fff', 0xffffff],
    ['#673AB7', 0x673ab7], ['rgba(242, 54, 69, 1)', 0xf23645], ['#000000', 0]]) {
    assert.equal(colorRgb(css), rgb);
    const marker = drawing('color', colored(30368.7, '5', css));
    assert.equal(marker.colorRgb, rgb); assert.equal(marker.timeframe, 'M5');
  }
  for (const value of ['rgb(256,0,0)', 'url(https://other)', 123, '#ggffff', 'rgba(1,2,3,2)']) {
    assert.throws(() => colorRgb(value), /цвет/);
  }
  assert.equal(colorRgb(undefined), null);
});

test('color-only edit changes revision and is acknowledged with the original price and period', async () => {
  const f = fixture(); f.bars();
  f.sync.acceptSource('color', colored(), { local: true }); await f.sync.tick();
  const revision = f.sync.records.get('color').revision;
  f.sync.acceptSource('color', colored(30368.7, '1', '#ffffff'), { local: true }); await f.sync.tick();
  const payloads = f.calls.filter(row => row.payload?.action === 'upsert').map(row => row.payload);
  assert.equal(payloads.length, 2); assert.equal(payloads[1].revision, revision + 1);
  assert.equal(payloads[1].time, payloads[0].time); assert.equal(payloads[1].side, 'high');
  assert.equal(payloads[1].colorRgb, 0xffffff); assert.equal(f.sync.status().ready, 1);
});

test('a ready reply with an old color cannot publish the edited level', async () => {
  const f = fixture(); f.bars(); f.sync.acceptSource('color', colored());
  f.adapter.request = async (_route, payload) => ({ candleLevels: { levels: [{
    ...f.sync.records.get('color'), symbol: 'USTEC', status: 'ready', price: 30380.25, colorRgb: 0xffffff
  }] } });
  await f.sync.tick();
  assert.equal(f.sync.status().ready, 0); assert.deepEqual(f.published.at(-1), { USTEC: [] });
});

test('outgoing drag is accepted despite a stale embedded server timestamp; stale remote snapshots stay ignored', async () => {
  const f = fixture(); f.bars();
  f.sync.acceptBars({ event: 'candle_bars', symbol: 'CAPITALCOM:NAS100', interval: '1', bars: [[TIME + 60, 30400, 30370]], windows: [[TIME + 60, TIME + 120]] });
  const first = { ...colored(), serverUpdateTime: 2000 };
  f.sync.acceptSource('drag', first, { local: true }); await f.sync.tick();
  const moved = { ...colored(30370, '1', '#673ab7', TIME + 60), serverUpdateTime: 1000 };
  f.sync.acceptSource('drag', moved, { local: true }); await f.sync.tick();
  const payload = f.calls.filter(row => row.payload?.action === 'upsert').at(-1).payload;
  assert.equal(payload.time, TIME + 60); assert.equal(payload.side, 'low'); assert.equal(payload.colorRgb, 0x673ab7);
  f.sync.acceptSource('drag', { ...first, serverUpdateTime: 500 });
  assert.equal(f.sync.records.get('drag').time, TIME + 60);
  for (const version of [1500, 2000]) {
    f.sync.acceptSource('drag', { ...first, serverUpdateTime: version });
    assert.equal(f.sync.records.get('drag').time, TIME + 60);
  }
  assert.equal(f.sync.records.get('drag').sourceVersion, 2000);
});

test('drag while old request is pending never publishes the old candle price', async () => {
  const f = fixture(); f.bars(); f.sync.acceptSource('drag', colored());
  f.sync.acceptBars({ event: 'candle_bars', symbol: 'CAPITALCOM:NAS100', interval: '1', bars: [[TIME + 60, 30400, 30370]], windows: [[TIME + 60, TIME + 120]] });
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.adapter.request = async (_route, payload) => {
    if (!payload) return { candleLevels: { levels: [] } };
    entered(); await new Promise(resolve => { finish = resolve; });
    return { candleLevels: { levels: [{ ...payload, price: 1, status: 'ready' }] } };
  };
  const pending = f.sync.tick(); await started;
  f.sync.acceptSource('drag', colored(30370, '1', '#673ab7', TIME + 60), { local: true });
  finish(); await pending;
  assert.ok(f.published.every(row => !(row.USTEC || []).includes(1)));
  assert.equal(f.sync.records.get('drag').time, TIME + 60);
});

test('a marker failure cannot prevent another source deletion, and its retries are bounded', async () => {
  const f = fixture(); f.bars();
  f.sync.acceptSource('first', shape()); await f.sync.tick();
  f.sync.acceptSource('second', shape()); await f.sync.tick();
  const firstId = f.sync.records.get('first').id, deletedId = f.sync.records.get('second').id;
  f.sync.acceptSource('first', shape(30340), { local: true });
  f.sync.acceptSource('second', null, { local: true });
  const requests = [];
  f.adapter.request = async (_route, payload) => {
    requests.push(payload);
    if (payload?.id === firstId) throw Error('one marker rejected');
    return { candleLevels: { levels: [] } };
  };
  await f.sync.tick();
  assert.equal(requests[0].id, deletedId); assert.equal(requests[0].action, 'delete');
  assert.equal(f.sync.records.get('second').phase, 'removed');
  const count = requests.length; await f.sync.tick(); assert.equal(requests.length, count);
  f.advance(2001); await f.sync.tick(); assert.equal(requests.length, count + 1);
});

test('failed deletion is visible and does not block a valid new level', async () => {
  const f = fixture(); f.bars(); f.sync.acceptSource('delete', shape()); await f.sync.tick();
  const deletedId = f.sync.records.get('delete').id;
  f.sync.acceptSource('delete', null); f.sync.acceptSource('good', shape());
  const goodId = f.sync.records.get('good').id;
  f.adapter.request = async (_route, payload) => {
    if (payload?.id === deletedId) throw Error('delete unavailable');
    return { candleLevels: { levels: [{ ...f.sync.records.get('good'), id: goodId, symbol: 'USTEC', price: 30380.25, status: 'ready' }] } };
  };
  await f.sync.tick();
  assert.equal(f.sync.status().ready, 1); assert.equal(f.sync.status().pendingRemovals, 1);
  assert.match(f.sync.status().reason, /delete unavailable/);
  f.adapter.request = async () => ({ candleLevels: { levels: [] } });
  f.advance(2001); await f.sync.tick(); assert.equal(f.sync.status().pendingRemovals, 0);
});

test('legacy receiver can delete an existing marker while a colored upsert waits for update', async () => {
  const f = fixture(); f.bars(); f.sync.acceptSource('old', shape()); await f.sync.tick();
  f.adapter.capabilities = ['candle-levels']; f.adapter.health = async () => {};
  f.sync.acceptSource('new', colored()); f.sync.acceptSource('old', null);
  await f.sync.tick();
  assert.equal(f.sync.records.get('old').phase, 'removed');
  assert.match(f.sync.records.get('new').requestError, /интервалов/);
  assert.equal(f.calls.filter(row => row.payload?.colorRgb != null).length, 0);
});

test('an exact TV window is required even when the selected high is already known', async () => {
  const f = fixture();
  f.sync.acceptBars({ event:'candle_bars',symbol:'CAPITALCOM:NAS100',interval:'1',bars:[[TIME,30368.7,30340]] });
  f.sync.acceptSource('one',shape()); await f.sync.tick();
  assert.equal(f.calls.length,0); assert.equal(f.sync.records.get('one').side,'high');
  assert.match(f.sync.records.get('one').reason,/границ/);
  f.bars(); await f.sync.tick();
  assert.equal(f.calls.find(row=>row.payload?.action==='upsert').payload.endTime,TIME+60);
  assert.equal(f.sync.status().ready,1);
});

test('a revised TV session end invalidates the old price and rejects its late reply', async () => {
  const f=fixture(); f.bars(30368.7,30340,'1D'); f.sync.acceptSource('day',shape(30368.7,'1D')); await f.sync.tick();
  const old={...f.sync.records.get('day')};
  f.sync.acceptBars({event:'candle_bars',symbol:'CAPITALCOM:NAS100',interval:'1D',bars:[[TIME,30368.7,30340]],windows:[[TIME,TIME+23*3600]]});
  assert.equal(f.sync.records.get('day').phase,'queued'); assert.deepEqual(f.sync.currentLevels(),{USTEC:[]});
  f.sync.acceptReply({levels:[{...old,symbol:'USTEC',status:'ready'}]});
  assert.equal(f.sync.status().ready,0);
  await f.sync.tick(); assert.equal(f.sync.status().ready,1);
  assert.equal(f.calls.filter(row=>row.payload?.action==='upsert').at(-1).payload.endTime,TIME+23*3600);
});

test('legacy saved geometry gets a new revision before a TV-window request is sent', async () => {
  const original=fixture();original.bars();original.sync.acceptSource('one',shape());await original.sync.tick();
  const state=original.sync.serialize(),oldRevision=state.records[0].revision;
  delete state.records[0].windowed;delete state.records[0].endTime;
  const f=fixture({initial:state});
  assert.equal(f.sync.records.get('one').revision,oldRevision+1);
  assert.equal(f.sync.records.get('one').phase,'awaiting-tv');
  await f.sync.tick();assert.equal(f.calls.at(-1).payload.action,'delete');
  f.bars();await f.sync.tick();assert.equal(f.sync.status().ready,1);
  assert.ok(f.calls.at(-2).payload.revision>oldRevision);
});

test('TV daily calendar uses symbol timezone and the actual session close across DST and weekends', () => {
  const sessions=[
    {start:1786917600,end:1787000400,wall:Date.UTC(2026,7,17,16)},
    {start:1792098000,end:1792184400,wall:Date.UTC(2026,9,16,16)},
    {start:1793574000,end:1793656800,wall:Date.UTC(2026,10,2,16)}
  ];
  class Session {
    constructor(timezone) {this.timezone=timezone;this.spec={timezoneObj:()=>timezone,bordersOfDailyBar:row=>({to:new Date(row.wall-1000)})};}
  }
  class Daily {
    constructor(target,source,period,builder){this._sessionTgt=target;this._sessionSrc=source;this._period=period;this._builder=builder;}
    moveTo(ms){assert.equal(this._sessionTgt.timezone,'America/Chicago');this.row=sessions.find(row=>row.start*1000===ms);}
    indexOfBar(){return 0;}startOfBar(){return this.row.start*1000;}
    currentRange(){return {to:{toCalendar:()=>this.row}};}
  }
  const base=new Daily(new Session('Europe/Moscow'),null,1,{});
  const reader=candleWindowReader({_prepareEndOfPeriodArgs:()=>({barBuilder:base})},{timezone:'America/Chicago',session:'1700-1600:2|1600-1600:3456'});
  for(const row of sessions)assert.equal(reader(row.start),row.end);
  assert.equal(base._sessionTgt.timezone,'Europe/Moscow');
  assert.equal(reader(TIME),null);
});

test('TV intraday calendar preserves a shortened H4 session and fails closed when its API changes', () => {
  class Session {constructor(timezone){this.timezone=timezone;}}
  class Intraday {
    constructor(period,session){this._periodSec=period;this._session=session;}
    moveTo(ms){this.time=ms;assert.equal(this._session.timezone,'America/Chicago');}
    indexOfBar(){return 5;}startOfBar(){return this.time;}endOfBar(){return this.time+3*3600000;}
  }
  const base=new Intraday(14400,new Session('Europe/Moscow'));
  const reader=candleWindowReader({_prepareEndOfPeriodArgs:()=>({barBuilder:base})},{timezone:'America/Chicago',session:'1700-1600:2|1600-1600:3456'});
  assert.equal(reader(1788199200),1788210000);
  assert.equal(candleWindowReader({},{})(TIME),null);
});

test('corrected TV OHLC can recover a previously non-extreme selection without moving to a neighbor', async () => {
  const f = fixture(); f.bars(30360); f.sync.acceptSource('corrected', shape());
  assert.equal(f.sync.records.get('corrected').phase, 'error');
  f.bars(); await f.sync.tick();
  assert.equal(f.sync.status().ready, 1);
  assert.equal(f.calls.find(row => row.payload?.action === 'upsert').payload.time, TIME);
  f.sync.acceptSource('corrected', null);
  f.bars(); await f.sync.tick(); assert.equal(f.sync.records.get('corrected').phase, 'removed');
});

for (const [interval, tf, color] of [['1D', 'D1', '#2962ff'], ['60', 'H1', '#ffffff'], ['5', 'M5', '#673ab7']]) {
  test(`${tf} retains its exact source candle and color across update and delete`, async () => {
    const f = fixture(); f.sync.acceptSource('period', colored(30368.7, interval, color));
    f.bars(); await f.sync.tick();
    if (interval !== '1') assert.equal(f.calls.length, 0);
    assert.match(f.sync.status().reason, new RegExp(tf));
    f.bars(30368.7, 30340, interval); await f.sync.tick();
    let payload = f.calls.find(row => row.payload?.action === 'upsert').payload;
    assert.equal(payload.timeframe, tf); assert.equal(payload.colorRgb, colorRgb(color));
    assert.equal(payload.time, TIME); assert.equal(payload.side, 'high');
    f.sync.acceptSource('period', colored(30340, interval, color), { local: true }); await f.sync.tick();
    payload = f.calls.filter(row => row.payload?.action === 'upsert').at(-1).payload;
    assert.equal(payload.timeframe, tf); assert.equal(payload.side, 'low');
    f.sync.acceptSource('period', null); await f.sync.tick();
    assert.deepEqual(f.published.at(-1), { USTEC: [] });
  });
}

test('delete waits for a complete MT5 snapshot acknowledgement and keeps LT clear meanwhile', async () => {
  const f = fixture(); f.bars(); f.sync.acceptSource('remove', colored()); await f.sync.tick();
  const old = { ...f.sync.records.get('remove') };
  f.sync.acceptSource('remove', null, { local: true });
  let applied = false, posts = 0;
  f.adapter.request = async (_route, payload) => {
    if (payload) posts++;
    return { candleLevels: { levels: [], snapshotApplied: applied } };
  };
  await f.sync.tick();
  assert.equal(f.sync.records.get('remove').phase, 'deleting');
  assert.equal(f.sync.status().pendingRemovals, 1); assert.match(f.sync.status().reason, /удаления/);
  assert.deepEqual(f.published.at(-1), { USTEC: [] });
  f.sync.acceptReply({ snapshotApplied: true, levels: [old] });
  assert.equal(f.sync.records.get('remove').phase, 'deleting');
  await f.sync.tick(); assert.equal(posts, 1);
  applied = true; await f.sync.tick();
  assert.equal(f.sync.records.get('remove').phase, 'removed'); assert.equal(f.sync.status().pendingRemovals, 0);
});

test('late deletion acknowledgement cannot remove a newly recreated source', async () => {
  const f = fixture(); f.bars(); f.sync.acceptSource('again', shape()); await f.sync.tick();
  f.sync.acceptSource('again', null); f.sync.acceptSource('again', shape(30340));
  f.sync.acceptReply({ snapshotApplied: true, levels: [] });
  assert.equal(f.sync.records.get('again').removed, false);
  await f.sync.tick(); assert.equal(f.sync.status().ready, 1);
});
