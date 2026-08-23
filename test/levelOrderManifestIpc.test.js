const assert = require('assert');
const {
  registerMainApplicationServices,
  registerMainIpcHandlers
} = require('../app/services/levelOrder/manifest');

async function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) {
      handlers.set(name, fn);
    }
  };
  const calls = [];
  const levelOrderService = {
    previewLevelOrder: async (payload) => {
      calls.push(['previewLevelOrder', payload]);
      return { ok: true, status: 'ok', plan: { ticker: payload.ticker } };
    },
    queueLevelOrder: async (payload) => {
      calls.push(['queueLevelOrder', payload]);
      return { status: 'ok', providerOrderId: 'level:test' };
    },
    stopRetry: async (reqId) => {
      calls.push(['stopRetry', reqId]);
      return { status: 'ok', stopped: 1 };
    },
    closeLevelOrderPositions: async (payload) => {
      calls.push(['closeLevelOrderPositions', payload]);
      return { status: 'ok', closed: 1 };
    }
  };

  registerMainIpcHandlers({
    ipcMain,
    servicesApi: {
      levelOrder: {
        applicationService: levelOrderService
      }
    }
  });

  assert.strictEqual(handlers.has('level-order:place'), true);
  assert.strictEqual(handlers.has('level-order:preview-place'), true);
  assert.strictEqual(handlers.has('execution:stop-retry'), true);
  assert.strictEqual(handlers.has('execution:close-level-order-positions'), true);

  assert.deepStrictEqual(
    await handlers.get('level-order:preview-place')(null, { ticker: 'ADAUSDT' }),
    { ok: true, status: 'ok', plan: { ticker: 'ADAUSDT' } }
  );
  assert.deepStrictEqual(
    await handlers.get('level-order:place')(null, { ticker: 'ADAUSDT' }),
    { status: 'ok', providerOrderId: 'level:test' }
  );
  assert.deepStrictEqual(
    await handlers.get('execution:stop-retry')(null, 'req-1'),
    { status: 'ok', stopped: 1 }
  );
  assert.deepStrictEqual(
    await handlers.get('execution:close-level-order-positions')(null, { symbol: 'ADAUSDT' }),
    { status: 'ok', closed: 1 }
  );
  assert.deepStrictEqual(calls, [
    ['previewLevelOrder', { ticker: 'ADAUSDT' }],
    ['queueLevelOrder', { ticker: 'ADAUSDT' }],
    ['stopRetry', 'req-1'],
    ['closeLevelOrderPositions', { symbol: 'ADAUSDT' }]
  ]);

  const servicesApi = {
    execution: {},
    levelOrder: {},
    positions: { handle() {} }
  };
  const executionService = {
    queuePlaceOrder: async (payload) => ({ status: 'queued', payload })
  };
  const applicationService = registerMainApplicationServices({
    servicesApi,
    getAdapter: () => ({}),
    wireAdapter: (adapter) => adapter,
    instrumentInfo: {},
    orderCalc: {},
    appendJsonl: () => {},
    execLog: 'test-executions.jsonl',
    nowTs: () => 1,
    sendToRenderer: () => {},
    resolveProviderName: () => 'simulated',
    executionService,
    pendingIndex: new Map(),
    trackerPending: new Map(),
    groupedOrderLifecycles: new Map()
  });

  assert.strictEqual(servicesApi.levelOrder.applicationService, applicationService);
  assert.strictEqual(typeof servicesApi.execution.queueLevelOrder, 'function');
  assert.strictEqual(typeof servicesApi.execution.previewLevelOrder, 'function');

  console.log('levelOrderManifestIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
