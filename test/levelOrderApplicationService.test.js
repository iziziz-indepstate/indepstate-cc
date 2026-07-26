const assert = require('assert');
const { createLevelOrderApplicationService, createLevelOrderRuntime } = require('../app/services/levelOrder');

async function run() {
  const logs = [];
  const startedMonitors = [];
  const placed = [];
  let releaseFirstPlacement;
  let firstPlacementBlocked = false;
  const runtime = createLevelOrderRuntime({
    getAdapter: () => ({}),
    wireAdapter: () => {},
    groupedOrderLifecycles: { get: () => null, getUnopenedTickets: () => [], takeReadySnapshot: () => null },
    levelOrderPositionMonitors: new Map(),
    appendJsonl: () => {},
    execLog: 'memory',
    sendToRenderer: () => {}
  });
  runtime.startLevelOrderPositionMonitor = (payload) => startedMonitors.push(payload);

  const service = createLevelOrderApplicationService({
    getAdapter: () => ({ listOpenPositions: async () => [] }),
    wireAdapter: () => {},
    instrumentInfo: {
      get: async () => ({ quote: { bid: 100, ask: 101 }, metadata: { quantityStep: 1 } }),
      resolveTickSize: () => 1
    },
    orderCalc: {
      qty: () => 12
    },
    appendJsonl: (_file, rec) => logs.push(rec),
    execLog: 'memory',
    nowTs: () => 2000,
    resolveProviderName: () => 'simulated',
    queuePlaceOrder: async (payload) => {
      placed.push(payload);
      if (!firstPlacementBlocked) {
        firstPlacementBlocked = true;
        await new Promise(resolve => { releaseFirstPlacement = resolve; });
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      return { status: 'ok', provider: 'simulated', providerOrderId: `ticket-${payload.meta.childIndex}` };
    },
    pendingIndex: new Map(),
    trackerPending: new Map(),
    levelOrderIntentRegistry: new Map(),
    runtime
  });

  const payload = {
    ticker: 'ADAUSDT',
    action: 'LB',
    level: 100,
    riskUsd: 12,
    stopOffsetPts: 1,
    maxLot: 5,
    minLot: 1,
    takeProfitPts: 9,
    requestId: 'parent-1',
    strategyId: 'strategy-1',
    instrumentType: 'EQ'
  };
  const firstPromise = service.queueLevelOrder(payload);
  await waitFor(() => placed.length === 1 && releaseFirstPlacement);
  const secondPromise = service.queueLevelOrder({ ...payload, requestId: 'parent-2', strategyId: 'strategy-2' });
  await waitFor(() => logs.some(item => item.kind === 'level-order-dedup'));
  releaseFirstPlacement();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.strictEqual(first.status, 'ok');
  assert.deepStrictEqual(second, first);
  assert.strictEqual(placed.length, 3);
  assert.deepStrictEqual(placed.map(item => item.meta.qty), [5, 5, 2]);
  assert.deepStrictEqual(placed.map(item => item.meta.childIndex), [1, 2, 3]);
  assert.strictEqual(placed[0].meta.parentRequestId, 'parent-1');
  assert.strictEqual(placed[0].kind, 'BL');
  assert.strictEqual(startedMonitors.length, 1);
  assert.strictEqual(logs.some(item => item.kind === 'level-order-dedup'), true);

  console.log('levelOrderApplicationService tests passed');
}

async function waitFor(predicate, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return predicate();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
