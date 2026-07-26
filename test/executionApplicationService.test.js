const assert = require('assert');
const { createExecutionApplicationService } = require('../app/application/execution');

async function run() {
  const logs = [];
  const renderer = [];
  const emitted = [];
  const placedOrders = [];
  const positionCalls = [];
  const pendingIndex = new Map();
  let placeResult = { status: 'ok', provider: 'simulated', providerOrderId: 'ticket-1' };
  let quote = { price: 100, bid: 99, ask: 101 };

  const service = createExecutionApplicationService({
    getAdapter: () => ({
      placeOrder: async (order) => {
        placedOrders.push(order);
        return placeResult;
      }
    }),
    wireAdapter: () => {},
    instrumentInfo: {
      get: async () => ({ quote, metadata: { quantityStep: 1 } }),
      getTickSizeResolution: () => ({ tickSize: 1, source: 'test' })
    },
    orderCalc: {
      qty: ({ riskUsd, stopPts, tickSize }) => riskUsd / (stopPts * tickSize)
    },
    tradeRules: { validate: () => ({ ok: true }) },
    events: { emit: (name, payload) => emitted.push({ name, payload }) },
    positions: {
      createAndOpen: (cmd) => positionCalls.push(['createAndOpen', cmd]),
      recordPlaced: (cmd) => positionCalls.push(['recordPlaced', cmd]),
      recordRejected: (cmd) => positionCalls.push(['recordRejected', cmd]),
      recordFailed: (cmd) => positionCalls.push(['recordFailed', cmd])
    },
    appendJsonl: (_file, rec) => logs.push(rec),
    execLog: 'memory',
    nowTs: () => 1000,
    sendToRenderer: (channel, payload) => renderer.push({ channel, payload }),
    trackerPending: new Map(),
    trackerIndex: new Map(),
    pendingIndex,
    resolveOrderProviderName: () => 'simulated',
    resolveProviderName: () => 'simulated',
    providerCanResolveRiskQty: () => false
  });

  const ok = await service.queuePlaceOrder({
    ticker: 'ADAUSDT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: { requestId: 'req-1', cid: 'cid-1', qty: 1, riskUsd: 10, stopPts: 5 }
  });
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(placedOrders.length, 1);
  assert.strictEqual(placedOrders[0].symbol, 'ADAUSDT');
  assert.strictEqual(placedOrders[0].side, 'buy');
  assert.strictEqual(placedOrders[0].type, 'limit');
  assert.match(placedOrders[0].comment, /cid:cid-1/);
  assert.strictEqual(renderer.some(item => item.channel === 'execution:result'), true);
  assert.strictEqual(emitted.some(item => item.name === 'order:placed'), true);
  assert.strictEqual(positionCalls.some(([name]) => name === 'createAndOpen'), true);
  assert.strictEqual(positionCalls.some(([name]) => name === 'recordPlaced'), true);

  quote = null;
  placedOrders.length = 0;
  const noQuote = await service.queuePlaceOrder({
    ticker: 'ADAUSDT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: { requestId: 'req-2', cid: 'cid-2', qty: 1, riskUsd: 10, stopPts: 5 }
  });
  assert.strictEqual(noQuote.status, 'rejected');
  assert.strictEqual(noQuote.reason, 'No quote');
  assert.strictEqual(placedOrders.length, 0);

  quote = { price: 100 };
  placeResult = { status: 'ok', provider: 'simulated', providerOrderId: 'pending:cid-3' };
  const pending = await service.queuePlaceOrder({
    ticker: 'ADAUSDT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: { requestId: 'req-3', cid: 'cid-3', qty: 1, riskUsd: 10, stopPts: 5 }
  });
  assert.strictEqual(pending.status, 'ok');
  assert.strictEqual(pending.providerOrderId, 'pending:cid-3');
  assert.strictEqual(pendingIndex.has('cid-3'), true);
  assert.strictEqual(renderer.some(item => item.channel === 'execution:pending' && item.payload.pendingId === 'cid-3'), true);

  console.log('executionApplicationService tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
