const assert = require('assert');

const points = require('../app/services/instrumentInfo/points');
const tradeRules = require('../app/services/tradeRules');
const orderCalculator = require('../app/services/orderCalculator');
const adapterRegistry = require('../app/services/brokerage/adapterRegistry');
const { PendingOrderService } = require('../app/services/pendingOrders/service');

function run() {
  points.configure({ defaultTickSize: 0.5, bySymbol: { LIVE: 0.25 }, patterns: [] });
  assert.strictEqual(points.getDefaultTickSize(), 0.5);
  assert.strictEqual(points.findTickSizeOverride('LIVE'), 0.25);

  tradeRules.configure({ rules: { maxQty: { default: 2 } } });
  assert.strictEqual(tradeRules.validate({ qty: 3, instrumentType: 'EQ' }).ok, false);
  tradeRules.configure({ rules: { maxQty: { default: 4 } } });
  assert.strictEqual(tradeRules.validate({ qty: 3, instrumentType: 'EQ' }).ok, true);

  orderCalculator.configure({
    profitRate: 5,
    riskUsd: {
      byInstrumentType: { EQ: 20, FX: 20, CX: 0.2 },
      bySymbol: { LIVE: 3 }
    }
  });
  assert.strictEqual(orderCalculator.takePts(2), 10);
  assert.strictEqual(orderCalculator.defaultRiskUsd({ symbol: 'live', instrumentType: 'EQ' }), 3);
  assert.strictEqual(orderCalculator.defaultRiskUsd({ symbol: 'OTHER', instrumentType: 'EQ' }), 20);

  adapterRegistry.initExecutionConfig({
    default: 'simulated',
    byInstrumentType: { EQ: 'simulated' },
    bySymbol: {},
    providers: { simulated: { adapter: 'simulated' }, alternate: { adapter: 'simulated' } }
  });
  let unavailable = adapterRegistry.updateExecutionRouting({
    default: 'alternate',
    byInstrumentType: { EQ: 'alternate' },
    bySymbol: {}
  }, ['default', 'byInstrumentType.EQ']);
  assert.deepStrictEqual(unavailable, []);
  assert.strictEqual(adapterRegistry.getExecutionConfig().default, 'alternate');
  unavailable = adapterRegistry.updateExecutionRouting({ default: 'new-provider' }, ['default']);
  assert.deepStrictEqual(unavailable, ['default']);
  assert.strictEqual(adapterRegistry.getExecutionConfig().default, 'alternate');

  const oldFactory = () => ({ marker: 'old', onBar() {} });
  const nextFactory = () => ({ marker: 'new', onBar() {} });
  const pending = new PendingOrderService({ createStrategy: oldFactory });
  const first = pending.addOrder({ price: 1, side: 'long' });
  pending.configureStrategies(nextFactory);
  const second = pending.addOrder({ price: 1, side: 'long' });
  assert.strictEqual(pending.orders.get(first).strategy.marker, 'old');
  assert.strictEqual(pending.orders.get(second).strategy.marker, 'new');

  console.log('live settings core tests passed');
}

run();
