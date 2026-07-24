const assert = require('assert');
const { createActionsBus } = require('../app/services/actions-bus');
const instrumentInfoManifest = require('../app/services/instrumentInfo/manifest');
const tvListenerManifest = require('../app/services/tvListener/manifest');
const optionstratManifest = require('../app/services/optionstrat/manifest');

function run() {
  const bus = createActionsBus();
  assert.deepStrictEqual(bus.listActionFunctions(), ['add', 'dist']);

  const instrumentInfo = {
    peek() { return { metadata: { tickSize: 0.5 } }; },
    toPoints(_context, delta) { return Math.round(Number(delta) / 0.5); }
  };
  instrumentInfoManifest.registerActionFunctions({ actionBus: bus, instrumentInfo });
  assert.deepStrictEqual(bus.listActionFunctions(), ['add', 'dist', 'distPts', 'distPtsPlus']);

  tvListenerManifest.registerActionFunctions({ actionBus: bus });
  assert.strictEqual(bus.listActionFunctions().includes('stripSymbol'), true);

  optionstratManifest.registerActionFunctions({ actionBus: bus });
  assert.strictEqual(bus.listActionFunctions().includes('optionLegs'), true);
  assert.strictEqual(bus.listActionFunctions().includes('optionLegPair'), true);

  const commands = [];
  bus.setCommandRunner(command => commands.push(command));
  bus.configure([
    { event: 'tv', action: 'symbol stripSymbol({symbol}) points distPtsPlus({price},{rayPrice},1)' },
    { event: 'options', action: 'legs optionLegs({legs}) pair optionLegPair({legs})' }
  ]);
  bus.emit('tv', { symbol: 'NYSE:AAA', price: 11, rayPrice: 10 });
  bus.emit('options', {
    legs: [
      { option: 'PUT', side: 'buy', strike: 7290, quantity: 1 },
      { option: 'PUT', side: 'sell', strike: 7280, quantity: 1 }
    ]
  });
  assert.deepStrictEqual(commands, [
    'symbol AAA points 3',
    'legs +1P7290/-1P7280 pair 7290/7280'
  ]);

  console.log('action function extension tests passed');
}

run();
