const assert = require('assert');
const { registerMainIpcHandlers } = require('../app/services/levelOrder/manifest');

async function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) {
      handlers.set(name, fn);
    }
  };
  const calls = [];
  const levelOrderService = {
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
    servicesApi: {},
    levelOrderService
  });

  assert.strictEqual(handlers.has('level-order:place'), true);
  assert.strictEqual(handlers.has('execution:stop-retry'), true);
  assert.strictEqual(handlers.has('execution:close-level-order-positions'), true);

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
    ['queueLevelOrder', { ticker: 'ADAUSDT' }],
    ['stopRetry', 'req-1'],
    ['closeLevelOrderPositions', { symbol: 'ADAUSDT' }]
  ]);

  console.log('levelOrderManifestIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
