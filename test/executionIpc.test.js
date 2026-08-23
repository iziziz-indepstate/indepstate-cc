const assert = require('assert');
const { registerExecutionIpcHandlers } = require('../app/infrastructure/execution');
const { createOptionStratCloseController } = require('../app/services/optionstrat/closeController');

async function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) {
      handlers.set(name, fn);
    }
  };
  const adapters = new Map([
    ['simulated', {
      cancelOrder: async (ticket, symbol) => ({ status: 'ok', ticket, symbol }),
      closePosition: async (position, reason) => ({ status: 'ok', provider: 'simulated', ticket: position.ticket, symbol: position.symbol, reason })
    }],
    ['optionstrat', {
      cancelOrder: async (ticket, symbol) => ({ status: 'ok', provider: 'optionstrat', ticket, symbol, valuation: { currentValue: 0 }, raw: { strategy: {} } })
    }],
    ['rejector', {
      cancelOrder: async (ticket, symbol) => ({ status: 'rejected', provider: 'rejector', ticket, symbol, reason: 'no-op' })
    }],
    ['unsupported', {
      cancelOrder: async (ticket, symbol) => ({ status: 'ok', ticket, symbol })
    }]
  ]);
  const closeControllerCalls = [];
  const previewCalls = [];
  const emitted = [];
  const events = {
    emit(name, payload) {
      emitted.push([name, payload]);
    }
  };

  registerExecutionIpcHandlers({
    ipcMain,
    executionService: {
      previewPlaceOrder: async (payload) => {
        previewCalls.push(payload);
        return { ok: true, status: 'ok', order: payload };
      }
    },
    getAdapter: (provider) => adapters.get(provider),
    wireAdapter: () => {},
    appendJsonl: () => {},
    execLog: 'memory',
    events,
    closeControllers: [{
      id: 'testCloseController',
      onCancelOrderResult: context => closeControllerCalls.push(context)
    }, createOptionStratCloseController({ events })],
    instrumentInfo: {
      get: async ({ provider, symbol }) => ({ provider, symbol }),
      forget: async ({ provider, symbol }) => ({ provider, symbol, forgotten: true })
    },
    detectInstrumentType: () => 'EQ',
    resolveProviderName: () => 'simulated'
  });

  assert.strictEqual(handlers.has('level-order:place'), false);
  assert.strictEqual(handlers.has('execution:stop-retry'), false);
  assert.strictEqual(handlers.has('execution:close-level-order-positions'), false);
  assert.strictEqual(handlers.has('execution:preview-place-order'), true);
  assert.strictEqual(handlers.has('execution:cancel-order'), true);
  assert.strictEqual(handlers.has('execution:close-position'), true);
  assert.strictEqual(handlers.has('optionstrat:button-event'), false);
  assert.strictEqual(handlers.has('optionstrat:estimate'), false);
  assert.strictEqual(handlers.has('optionstrat:valuation'), false);
  assert.strictEqual(handlers.has('instrument:get'), true);

  const preview = await handlers.get('execution:preview-place-order')(null, { symbol: 'AAPL' });
  assert.deepStrictEqual(preview, { ok: true, status: 'ok', order: { symbol: 'AAPL' } });
  assert.deepStrictEqual(previewCalls, [{ symbol: 'AAPL' }]);

  const cancel = await handlers.get('execution:cancel-order')(null, { provider: 'simulated', ticket: 't1', symbol: 'ADAUSDT' });
  assert.strictEqual(cancel.status, 'ok');
  assert.strictEqual(cancel.ticket, 't1');
  assert.strictEqual(closeControllerCalls.length, 1);
  assert.strictEqual(closeControllerCalls[0].providerName, 'simulated');
  assert.strictEqual(closeControllerCalls[0].ticket, 't1');
  assert.strictEqual(closeControllerCalls[0].events, events);
  assert.deepStrictEqual(emitted, []);

  const optionClose = await handlers.get('execution:cancel-order')(null, { provider: 'optionstrat', ticket: 'deal-1', symbol: 'SPY', name: 'LCS' });
  assert.strictEqual(optionClose.status, 'ok');
  assert.strictEqual(closeControllerCalls.length, 2);
  assert.strictEqual(closeControllerCalls[1].providerName, 'optionstrat');
  assert.strictEqual(closeControllerCalls[1].ticket, 'deal-1');
  assert.strictEqual(closeControllerCalls[1].name, 'LCS');
  assert.strictEqual(closeControllerCalls[1].events, events);
  assert.strictEqual(emitted.length, 1);
  assert.deepStrictEqual(emitted.map(call => call[0]), ['order:closed']);
  assert.deepStrictEqual(emitted[0][1], {
    provider: 'optionstrat',
    ticket: 'deal-1',
    symbol: 'SPY',
    order: { name: 'LCS' },
    result: {
      status: 'ok',
      provider: 'optionstrat',
      ticket: 'deal-1',
      symbol: 'SPY',
      valuation: { currentValue: 0 },
      raw: { strategy: {} }
    }
  });

  const rejectedCancel = await handlers.get('execution:cancel-order')(null, { provider: 'rejector', ticket: 'r1', symbol: 'SPY' });
  assert.strictEqual(rejectedCancel.status, 'rejected');
  assert.strictEqual(closeControllerCalls.length, 2);
  assert.strictEqual(emitted.length, 1);

  const closedPosition = await handlers.get('execution:close-position')(null, { provider: 'simulated', ticket: 'p1', symbol: 'ADAUSDT', snapshot: { id: 'pos-1' } });
  assert.strictEqual(closedPosition.status, 'ok');
  assert.strictEqual(closedPosition.ticket, 'p1');
  assert.strictEqual(closedPosition.symbol, 'ADAUSDT');

  const missingClosePayload = await handlers.get('execution:close-position')(null, { provider: 'simulated' });
  assert.strictEqual(missingClosePayload.status, 'error');

  const unsupportedClose = await handlers.get('execution:close-position')(null, { provider: 'unsupported', ticket: 'u1', symbol: 'SPY' });
  assert.strictEqual(unsupportedClose.status, 'unsupported');

  const instrument = await handlers.get('instrument:get')(null, { symbol: 'ADAUSDT' });
  assert.strictEqual(instrument.provider, 'simulated');
  assert.strictEqual(instrument.symbol, 'ADAUSDT');

  console.log('executionIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
