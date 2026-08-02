const assert = require('assert');
const { registerExecutionIpcHandlers } = require('../app/infrastructure/execution');

async function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) {
      handlers.set(name, fn);
    }
  };
  const calls = [];
  const adapters = new Map([
    ['simulated', {
      cancelOrder: async (ticket, symbol) => ({ status: 'ok', ticket, symbol }),
      estimateOrder: async (order) => ({ status: 'ok', order }),
      getStrategyValuation: async (ticket, symbol) => ({ status: 'ok', ticket, symbol })
    }]
  ]);

  registerExecutionIpcHandlers({
    ipcMain,
    executionService: {
      resolveOrderProviderName: () => 'simulated'
    },
    getAdapter: (provider) => adapters.get(provider),
    wireAdapter: () => {},
    appendJsonl: () => {},
    execLog: 'memory',
    events: { emit: (name, payload) => calls.push(['emit', name, payload]) },
    buildOptionStratHedgePayload: () => ({
      eventName: 'hedge:test',
      payload: { hedgeOpenSide: 'buy' }
    }),
    servicesApi: {
      actionBus: { emit: (name, payload) => calls.push(['actionBus', name, payload]) }
    },
    instrumentInfo: {
      get: async ({ provider, symbol }) => ({ provider, symbol }),
      forget: async ({ provider, symbol }) => ({ provider, symbol, forgotten: true })
    },
    detectInstrumentType: () => 'EQ',
    resolveProviderName: () => 'simulated',
    normalizeOrderPayload: (payload) => ({ ...payload, symbol: payload.symbol || payload.ticker })
  });

  assert.strictEqual(handlers.has('level-order:place'), false);
  assert.strictEqual(handlers.has('execution:stop-retry'), false);
  assert.strictEqual(handlers.has('execution:close-level-order-positions'), false);
  assert.strictEqual(handlers.has('execution:cancel-order'), true);
  assert.strictEqual(handlers.has('optionstrat:estimate'), true);
  assert.strictEqual(handlers.has('instrument:get'), true);

  const cancel = await handlers.get('execution:cancel-order')(null, { provider: 'simulated', ticket: 't1', symbol: 'ADAUSDT' });
  assert.strictEqual(cancel.status, 'ok');
  assert.strictEqual(cancel.ticket, 't1');

  const optionButton = await handlers.get('optionstrat:button-event')(null, { action: 'x', row: {} });
  assert.strictEqual(optionButton.ok, true);
  assert.strictEqual(calls.some(call => call[0] === 'actionBus' && call[1] === 'hedge:test'), true);

  const estimate = await handlers.get('optionstrat:estimate')(null, { symbol: 'SPY', legs: [{}] });
  assert.strictEqual(estimate.status, 'ok');

  const valuation = await handlers.get('optionstrat:valuation')(null, { provider: 'simulated', ticket: 'strategy-1', symbol: 'SPY' });
  assert.strictEqual(valuation.status, 'ok');

  const instrument = await handlers.get('instrument:get')(null, { symbol: 'ADAUSDT' });
  assert.strictEqual(instrument.provider, 'simulated');
  assert.strictEqual(instrument.symbol, 'ADAUSDT');

  console.log('executionIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
