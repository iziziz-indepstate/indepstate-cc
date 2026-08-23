const assert = require('assert');
const { registerPendingOrdersIpcHandlers } = require('../app/services/pendingOrders');

async function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) {
      handlers.set(name, fn);
    }
  };
  const calls = [];
  const pendingHub = {
    previewPlacePending(payload) {
      calls.push(['previewPlacePending', payload]);
      return { ok: true, status: 'ok', provider: 'simulated', pending: payload, errors: [] };
    },
    queuePlacePending(payload) {
      calls.push(['queuePlacePending', payload]);
      return { status: 'ok', providerOrderId: 'pending:1' };
    },
    cancelPending(pendingId) {
      calls.push(['cancelPending', pendingId]);
      return { status: 'ok' };
    }
  };

  registerPendingOrdersIpcHandlers({
    ipcMain,
    pendingHub,
    queuePlaceOrder: async (payload) => {
      calls.push(['queuePlaceOrder', payload]);
      return { status: 'ok', providerOrderId: 'ticket-1' };
    }
  });

  assert.strictEqual(handlers.has('queue-place-order'), true);
  assert.strictEqual(handlers.has('pending:preview-place'), true);
  assert.strictEqual(handlers.has('queue-place-pending'), true);
  assert.strictEqual(handlers.has('pending:cancel'), true);

  assert.deepStrictEqual(await handlers.get('queue-place-order')(null, { symbol: 'AAPL' }), { status: 'ok', providerOrderId: 'ticket-1' });
  assert.deepStrictEqual(await handlers.get('pending:preview-place')(null, { symbol: 'AAPL' }), {
    ok: true,
    status: 'ok',
    provider: 'simulated',
    pending: { symbol: 'AAPL' },
    errors: []
  });
  assert.deepStrictEqual(await handlers.get('queue-place-pending')(null, { symbol: 'AAPL' }), { status: 'ok', providerOrderId: 'pending:1' });
  assert.deepStrictEqual(await handlers.get('pending:cancel')(null, 'pending-1'), { status: 'ok' });
  assert.deepStrictEqual(calls.map(call => call[0]), [
    'queuePlaceOrder',
    'previewPlacePending',
    'queuePlacePending',
    'cancelPending'
  ]);

  console.log('pendingOrdersIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
