const assert = require('assert');
const { createActionsBus } = require('../app/services/actions-bus');
const { createInstrumentInfoActionFunctions } = require('../app/services/instrumentInfo/actionFunctions');
const { stripSymbol } = require('../app/services/tvListener/actionFunctions');
const { optionLegs, optionLegPair } = require('../app/services/optionstrat/actionFunctions');

async function run() {
  const executed = [];
  const errors = [];
  const bus = createActionsBus({
    onError(err) {
      errors.push(err.message);
    }
  });
  assert.deepStrictEqual(bus.listActionFunctions(), ['add', 'dist']);
  const warmInstrumentInfo = {
    peek() { return { metadata: { tickSize: 0.01 } }; },
    toPoints(_context, delta) { return Math.round(Number(delta) / 0.01); }
  };
  for (const [name, fn] of Object.entries(createInstrumentInfoActionFunctions(warmInstrumentInfo))) {
    bus.registerActionFunction(name, fn);
  }
  bus.registerActionFunction('stripSymbol', stripSymbol);
  bus.registerActionFunction('optionLegs', optionLegs);
  bus.registerActionFunction('optionLegPair', optionLegPair);
  bus.registerActionFunction('joinSymbolLevel', (symbol, price) => `${symbol}@${price}`);

  bus.configure([
    {
      name: 'Foo action',
      label: 'Foo toggle',
      bindings: [
        { event: 'foo', action: 'commandLine:test {symbol}' },
        { event: 'bar', action: 'commandLine:bar {symbol}' },
        { event: 'tv', action: 'commandLine:lo stripSymbol({symbol}) {price} props=producingLineId:{lineId}' },
        { event: 'plain', action: 'commandLine:plain stripSymbol({symbol})' },
        { event: 'custom', action: 'commandLine:custom joinSymbolLevel({symbol}, {price})' },
        { event: 'ray', action: 'commandLine:lo stripSymbol({symbol}) {price} props=stopOffsetPts:dist({price},{rayPrice});stopOffsetTicks:distPts({price},{rayPrice});stopPlusExtra:distPtsPlus({price},{rayPrice},{extraPts});producingLineId:{lineId}' },
        { event: 'blank-ray', action: 'commandLine:blank-ray dist({price},{rayPrice}) distPts({price},{rayPrice}) distPtsPlus({price},{rayPrice},{extraPts})' },
        { event: 'add-helper', action: 'commandLine:add-helper add({price},{offset}, {extra})' },
        { event: 'unknown-fn', action: 'commandLine:unknown missingFn({symbol}) keep-going' }
      ]
    },
    { event: 'foo', action: 'other:always-run' },
    { event: 'foo', action: 'no-prefix-run' },
    { event: 'legs', action: 'webhook:send is-simple-txt props=text:{legs[0].strike}/{legs[1].strike}' },
    { event: 'legs-helper', action: 'webhook:send is-simple-txt props=text:optionLegs({legs})' },
    { event: 'option-open', action: 'webhook:send is-simple-txt props=text:{optionOpenLegsText} net {optionOpenNetPrice}' },
    { event: 'option-close', action: 'webhook:send is-simple-txt props=text:{optionCloseLegsText} net {optionCloseNetPrice} pnl {optionPnl}' }
  ]);

  let named = bus.listNamedActions();
  assert.deepStrictEqual(named, [{ name: 'Foo action', label: 'Foo toggle', enabled: true }]);

  bus.emit('foo', { symbol: 'AAA' });
  bus.emit('bar', { symbol: 'AAA' });
  bus.emit('tv', { symbol: 'NYSE:AAA', price: 1.23, lineId: 'foo' });
  bus.emit('plain', { symbol: 'ES.cfd' });
  bus.emit('custom', { symbol: 'AAA', price: 1.23 });
  bus.emit('ray', { symbol: 'NYSE:AAA', price: 1.5, rayPrice: 1.35, extraPts: 2, lineId: 'foo' });
  bus.emit('blank-ray', { symbol: 'NYSE:AAA', price: 1.5, extraPts: 2 });
  bus.emit('add-helper', { price: 1.5, offset: 0.15, extra: 0.2 });
  bus.emit('unknown-fn', { symbol: 'AAA' });
  assert.deepStrictEqual(executed, []);
  assert.deepStrictEqual(errors, ['Unknown action function: missingFn']);
  errors.length = 0;

  const commandLineRunner = (cmd) => {
    executed.push(`cli:${cmd}`);
    return { ok: true };
  };

  bus.registerCommandRunner('commandLine', commandLineRunner);
  bus.setCommandRunner(commandLineRunner);

  bus.registerCommandRunner('other', (cmd) => {
    executed.push(`other:${cmd}`);
    return { ok: true };
  });
  bus.registerCommandRunner('webhook', (cmd) => {
    executed.push(`webhook:${cmd}`);
    return { ok: true };
  });

  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:bar AAA',
    'cli:lo AAA 1.23 props=producingLineId:foo',
    'cli:plain ES.cfd',
    'cli:custom AAA@1.23',
    'cli:lo AAA 1.5 props=stopOffsetPts:0.15;stopOffsetTicks:15;stopPlusExtra:17;producingLineId:foo',
    'cli:blank-ray   ',
    'cli:add-helper 1.85',
    'cli:unknown  keep-going',
    'cli:no-prefix-run',
    'other:always-run'
  ]);
  assert.deepStrictEqual(errors, ['Unknown action function: missingFn']);
  errors.length = 0;

  bus.emit('foo', { symbol: 'AAA' });
  bus.emit('bar', { symbol: 'AAA' });
  bus.emit('legs', { legs: [{ option: 'PUT', side: 'buy', strike: 7290, quantity: 1 }, { option: 'PUT', side: 'sell', strike: 7280, quantity: 1 }] });
  bus.emit('legs-helper', { legs: [{ option: 'PUT', side: 'buy', strike: 7290, quantity: 1 }, { option: 'PUT', side: 'sell', strike: 7280, quantity: 1 }] });
  bus.emit('option-open', { optionOpenLegsText: '+1C7500@1.20/-1C7510@0.45', optionOpenNetPrice: 0.75 });
  bus.emit('option-close', { optionCloseLegsText: '+1C7500@1.75/-1C7510@0.30', optionCloseNetPrice: 1.45, optionPnl: 600 });
  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:bar AAA',
    'cli:lo AAA 1.23 props=producingLineId:foo',
    'cli:plain ES.cfd',
    'cli:custom AAA@1.23',
    'cli:lo AAA 1.5 props=stopOffsetPts:0.15;stopOffsetTicks:15;stopPlusExtra:17;producingLineId:foo',
    'cli:blank-ray   ',
    'cli:add-helper 1.85',
    'cli:unknown  keep-going',
    'cli:no-prefix-run',
    'other:always-run',
    'cli:test AAA',
    'other:always-run',
    'cli:no-prefix-run',
    'cli:bar AAA',
    'webhook:send is-simple-txt props=text:7290/7280',
    'webhook:send is-simple-txt props=text:+1P7290/-1P7280',
    'webhook:send is-simple-txt props=text:+1C7500@1.20/-1C7510@0.45 net 0.75',
    'webhook:send is-simple-txt props=text:+1C7500@1.75/-1C7510@0.30 net 1.45 pnl 600'
  ]);

  bus.setActionEnabled('Foo action', false);
  assert.strictEqual(bus.getActionState('Foo action'), false);
  bus.emit('foo', { symbol: 'BBB' });
  bus.emit('bar', { symbol: 'BBB' });
  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:bar AAA',
    'cli:lo AAA 1.23 props=producingLineId:foo',
    'cli:plain ES.cfd',
    'cli:custom AAA@1.23',
    'cli:lo AAA 1.5 props=stopOffsetPts:0.15;stopOffsetTicks:15;stopPlusExtra:17;producingLineId:foo',
    'cli:blank-ray   ',
    'cli:add-helper 1.85',
    'cli:unknown  keep-going',
    'cli:no-prefix-run',
    'other:always-run',
    'cli:test AAA',
    'other:always-run',
    'cli:no-prefix-run',
    'cli:bar AAA',
    'webhook:send is-simple-txt props=text:7290/7280',
    'webhook:send is-simple-txt props=text:+1P7290/-1P7280',
    'webhook:send is-simple-txt props=text:+1C7500@1.20/-1C7510@0.45 net 0.75',
    'webhook:send is-simple-txt props=text:+1C7500@1.75/-1C7510@0.30 net 1.45 pnl 600',
    'other:always-run',
    'cli:no-prefix-run'
  ]);

  bus.configure([
    { event: 'bar', action: 'commandLine:second {price}', name: 'Second' }
  ]);

  executed.length = 0;
  bus.emit('bar', { price: 1.23 });
  assert.deepStrictEqual(executed, ['cli:second 1.23']);

  named = bus.listNamedActions();
  assert.deepStrictEqual(named, [{ name: 'Second', label: 'Second', enabled: true }]);
  assert.strictEqual(bus.getActionState('Foo action'), undefined);
  assert.ok(bus.listActionFunctions().includes('stripSymbol'));
  assert.ok(bus.listActionFunctions().includes('add'));
  assert.ok(bus.listActionFunctions().includes('distPtsPlus'));
  assert.ok(bus.listActionFunctions().includes('optionLegs'));
  assert.ok(bus.listActionFunctions().includes('optionLegPair'));
  assert.ok(bus.listActionFunctions().includes('joinSymbolLevel'));
  assert.strictEqual(bus.unregisterActionFunction('joinSymbolLevel'), true);
  assert.ok(!bus.listActionFunctions().includes('joinSymbolLevel'));

  let warm = false;
  let lookups = 0;
  const asyncExecuted = [];
  const asyncBus = createActionsBus();
  const coldInstrumentInfo = {
    peek() { return warm ? { metadata: { tickSize: 0.5 } } : null; },
    async get() { lookups += 1; warm = true; return { metadata: { tickSize: 0.5 } }; },
    toPoints(_context, delta) { return Math.round(Number(delta) / 0.5); }
  };
  for (const [name, fn] of Object.entries(createInstrumentInfoActionFunctions(coldInstrumentInfo))) {
    asyncBus.registerActionFunction(name, fn);
  }
  asyncBus.setCommandRunner(cmd => asyncExecuted.push(cmd));
  asyncBus.configure([
    { event: 'cold', action: 'first distPts({price},{rayPrice})' },
    { event: 'cold', action: 'second {symbol}' }
  ]);
  asyncBus.emit('cold', { symbol: 'AAA', price: 11, rayPrice: 10 });
  assert.deepStrictEqual(asyncExecuted, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(lookups, 1);
  assert.deepStrictEqual(asyncExecuted, ['first 2', 'second AAA']);
  asyncBus.emit('cold', { symbol: 'AAA', price: 10.1, rayPrice: 10 });
  assert.deepStrictEqual(asyncExecuted.slice(-2), ['first 0', 'second AAA']);

  const defaultStateExecuted = [];
  const persistedStates = {};
  const defaultStateBus = createActionsBus({
    initialActionStates: { Restored: true },
    onActionStateChange(name, enabled) {
      persistedStates[name] = enabled;
    }
  });
  defaultStateBus.setCommandRunner(cmd => defaultStateExecuted.push(cmd));
  defaultStateBus.configure([
    { name: 'Disabled by config', enabled: false, event: 'disabled', action: 'disabled' },
    {
      name: 'Restored',
      enabled: false,
      bindings: [{ event: 'restored', action: 'restored' }]
    }
  ]);
  assert.deepStrictEqual(defaultStateBus.listNamedActions(), [
    { name: 'Disabled by config', label: 'Disabled by config', enabled: false },
    { name: 'Restored', label: 'Restored', enabled: true }
  ]);
  defaultStateBus.emit('disabled');
  defaultStateBus.emit('restored');
  assert.deepStrictEqual(defaultStateExecuted, ['restored']);

  defaultStateBus.setActionEnabled('Disabled by config', true);
  assert.deepStrictEqual(persistedStates, { 'Disabled by config': true });
  defaultStateBus.emit('disabled');
  assert.deepStrictEqual(defaultStateExecuted, ['restored', 'disabled']);

  const restartedBus = createActionsBus({ initialActionStates: persistedStates });
  restartedBus.configure([
    { name: 'Disabled by config', enabled: false, event: 'disabled', action: 'disabled' }
  ]);
  assert.strictEqual(restartedBus.getActionState('Disabled by config'), true);

  console.log('actionsBus tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
