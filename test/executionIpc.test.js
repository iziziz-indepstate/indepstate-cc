const assert = require('assert');
const { registerExecutionIpcHandlers } = require('../app/infrastructure/execution');

async function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) {
      handlers.set(name, fn);
    }
  };
  const adapters = new Map([
    ['simulated', {
      cancelOrder: async (ticket, symbol) => ({ status: 'ok', ticket, symbol })
    }]
  ]);

  registerExecutionIpcHandlers({
    ipcMain,
    getAdapter: (provider) => adapters.get(provider),
    wireAdapter: () => {},
    appendJsonl: () => {},
    execLog: 'memory',
    events: { emit: () => {} },
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
  assert.strictEqual(handlers.has('execution:cancel-order'), true);
  assert.strictEqual(handlers.has('optionstrat:button-event'), false);
  assert.strictEqual(handlers.has('optionstrat:estimate'), false);
  assert.strictEqual(handlers.has('optionstrat:valuation'), false);
  assert.strictEqual(handlers.has('instrument:get'), true);

  const cancel = await handlers.get('execution:cancel-order')(null, { provider: 'simulated', ticket: 't1', symbol: 'ADAUSDT' });
  assert.strictEqual(cancel.status, 'ok');
  assert.strictEqual(cancel.ticket, 't1');

  const instrument = await handlers.get('instrument:get')(null, { symbol: 'ADAUSDT' });
  assert.strictEqual(instrument.provider, 'simulated');
  assert.strictEqual(instrument.symbol, 'ADAUSDT');

  console.log('executionIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
