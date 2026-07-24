const assert = require('assert');
const fs = require('fs');
const path = require('path');
const events = require('../app/services/events');
const servicesApi = require('../app/services/servicesApi');
const { MinStopPointsRule } = require('../app/services/tradeRules/minStopPoints');
const { buildOrderCalculator } = require('../app/services/orderCalculator');
const { createProviderResolver } = require('../app/services/brokerage/providerResolver');

const logsDir = path.join(__dirname, '..', 'app', 'logs');
const execLog = path.join(logsDir, 'executions.jsonl');
fs.mkdirSync(logsDir, { recursive: true });
fs.writeFileSync(execLog, '');

async function waitFor(fn, attempts = 10) {
  for (let i = 0; i < attempts; i += 1) {
    const value = fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return fn();
}

async function run() {
  servicesApi.tradeRules = {
    rules: [
      new MinStopPointsRule({ default: 6, byInstrumentType: { FX: 6, EQ: 6 } })
    ]
  };
  servicesApi.orderCalculator = buildOrderCalculator({}, servicesApi);
  const { PendingOrderHub } = require('../app/services/pendingOrders');
  const resolver = createProviderResolver({
    getExecutionConfig: () => ({
      default: 'simulated',
      bySymbol: { TEST: 'j2t', TPTEST: 'j2t' },
      byInstrumentType: { EQ: 'dwx', FX: 'dwx' }
    })
  });

  let placed;
  const hub = new PendingOrderHub({
    queuePlaceOrder: async (o) => {
      await Promise.resolve();
      placed = o;
    },
    subscribe: () => {},
    wireAdapter: () => {},
    getAdapter: () => ({}),
    resolveProvider: resolver.resolveProvider,
    strategyConfig: {}
  });

  const queued = hub.queuePlacePending({
    ticker: 'TEST',
    price: 100,
    side: 'long',
    instrumentType: 'EQ',
    tickSize: 1,
    meta: { qty: 3, riskUsd: 0 }
  });
  assert.strictEqual(queued.provider, 'j2t');

  const bars = [
    { open: 99, high: 101, low: 98, close: 100.5 },
    { open: 100.2, high: 100.8, low: 100, close: 100.7 },
    { open: 100.5, high: 101, low: 100.1, close: 100.9 }
  ];
  bars.forEach(b => events.emit('bar', { provider: queued.provider, symbol: 'TEST', tf: 'M1', ...b }));
  await waitFor(() => placed);

  assert.ok(placed, 'order was not sent for execution');
  assert.strictEqual(placed.side, 'buy');
  assert.strictEqual(placed.type, 'limit');
  assert.strictEqual(placed.price, 101);
  assert.strictEqual(placed.qty, 3);
  assert.strictEqual(placed.provider, 'j2t');
  assert.strictEqual(placed.sl, 6);
  assert.strictEqual(placed.meta.stopPts, 6);
  assert.strictEqual(placed.tp, 18);
  assert.strictEqual(placed.meta.takePts, 18);

  // strategy providing takeProfit and tickSize requiring conversion
  placed = undefined;
  const hub2 = new PendingOrderHub({
    queuePlaceOrder: async (o) => { placed = o; },
    subscribe: () => {},
    wireAdapter: () => {},
    getAdapter: () => ({}),
    resolveProvider: resolver.resolveProvider,
    strategyConfig: {},
    strategies: {
      stub: class {
        constructor() { this.done = false; }
        onBar() {
          if (this.done) return null;
          this.done = true;
          return { limitPrice: 101, stopLoss: 99, takeProfit: 105 };
        }
      }
    }
  });

  const queued2 = hub2.queuePlacePending({
    ticker: 'TPTEST',
    provider: 'SIMULATED',
    price: 100,
    side: 'long',
    strategy: 'stub',
    instrumentType: 'FX',
    tickSize: 0.5,
    meta: { qty: 1 }
  });
  assert.strictEqual(queued2.provider, 'simulated');

  events.emit('bar', { provider: queued2.provider, symbol: 'TPTEST', tf: 'M1', open: 100, high: 101, low: 99, close: 100 });
  await waitFor(() => placed);

  assert.ok(placed, 'takeProfit order was not executed');
  assert.strictEqual(placed.provider, 'simulated');
  assert.strictEqual(placed.sl, 6); // diff 2 -> 4 pts -> clamped to 6
  assert.strictEqual(placed.tp, 18); // stop*3 rule
  assert.strictEqual(placed.meta.stopPts, 6);
  assert.strictEqual(placed.meta.takePts, 18);

  // LEVEL_OFFSET treats the card SL as the extra distance beyond the level.
  placed = undefined;
  const levelOffsetHub = new PendingOrderHub({
    queuePlaceOrder: async (o) => { placed = o; },
    subscribe: () => {},
    wireAdapter: () => {},
    getAdapter: () => ({}),
    resolveProvider: resolver.resolveProvider,
    strategyConfig: {
      consolidation: { bars: 1, stoppLossRule: 'LEVEL_OFFSET' }
    }
  });

  const levelOffsetQueued = levelOffsetHub.queuePlacePending({
    ticker: 'TEST',
    price: 100,
    side: 'long',
    instrumentType: 'EQ',
    tickSize: 0.5,
    meta: { qty: 1, riskUsd: 12, stopPts: 2 }
  });
  assert.strictEqual(levelOffsetQueued.status, 'ok');

  events.emit('bar', {
    provider: levelOffsetQueued.provider,
    symbol: 'TEST',
    tf: 'M1',
    open: 99,
    high: 102,
    low: 98,
    close: 101
  });
  await waitFor(() => placed);

  assert.ok(placed, 'level-offset order was not sent for execution');
  assert.strictEqual(placed.price, 102);
  assert.strictEqual(placed.sl, 6); // 4 pts entry-to-level + 2 pts beyond level
  assert.strictEqual(placed.meta.stopPts, 6);
  assert.strictEqual(placed.qty, 4); // $12 / (6 pts * $0.50)

  const invalidLevelOffset = levelOffsetHub.queuePlacePending({
    ticker: 'TEST',
    price: 100,
    side: 'long',
    instrumentType: 'EQ',
    tickSize: 0.5,
    meta: { qty: 1, riskUsd: 12 }
  });
  assert.strictEqual(invalidLevelOffset.status, 'rejected');
  assert.match(invalidLevelOffset.reason, /stopOffsetPts > 0/);
  console.log('pendingOrdersHub tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
