const assert = require('assert');
const {
  registerMainApplicationServices,
  registerMainIpcHandlers
} = require('../app/services/optionstrat/manifest');

async function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) {
      handlers.set(name, fn);
    }
  };
  const calls = [];
  const adapters = new Map([
    ['optionstrat', {
      estimateOrder: async (order) => {
        calls.push(['estimateOrder', order]);
        return { status: 'ok', provider: 'optionstrat', order };
      },
      getStrategyValuation: async (ticket, symbol) => {
        calls.push(['getStrategyValuation', ticket, symbol]);
        return { status: 'ok', provider: 'optionstrat', ticket, symbol };
      }
    }],
    ['unsupported', {}]
  ]);
  const servicesApi = {
    actionBus: {
      emit(name, payload) {
        calls.push(['actionBus', name, payload]);
      }
    }
  };
  const service = registerMainApplicationServices({
    servicesApi,
    getAdapter: provider => adapters.get(provider),
    wireAdapter: (adapter, provider) => {
      calls.push(['wireAdapter', provider]);
      return adapter;
    },
    executionService: {
      resolveOrderProviderName: order => order.provider || 'optionstrat'
    },
    resolveProviderName: () => 'optionstrat',
    normalizeOrderPayload: payload => ({ ...payload, symbol: payload.symbol || payload.ticker })
  });

  assert.strictEqual(servicesApi.optionstrat.applicationService, service);

  registerMainIpcHandlers({ ipcMain, servicesApi });

  assert.strictEqual(handlers.has('optionstrat:button-event'), true);
  assert.strictEqual(handlers.has('optionstrat:estimate'), true);
  assert.strictEqual(handlers.has('optionstrat:valuation'), true);

  const button = await handlers.get('optionstrat:button-event')(null, {
    action: 'open',
    row: { strategyCommand: 'lcs', ticker: 'SPY', provider: 'optionstrat' }
  });
  assert.strictEqual(button.ok, true);
  assert.strictEqual(button.event, 'optionstrat:open-clicked');
  assert.strictEqual(button.payload.hedgeOpenSide, 'buy');
  assert.strictEqual(calls.some(call => call[0] === 'actionBus' && call[1] === 'optionstrat:open-clicked'), true);

  const unsupportedHedge = await handlers.get('optionstrat:button-event')(null, {
    action: 'open',
    row: { strategyCommand: 'bcs', ticker: 'SPY', provider: 'optionstrat' }
  });
  assert.deepStrictEqual(unsupportedHedge, {
    ok: false,
    reason: 'Unsupported OptionStrat strategy for hedge automation'
  });

  const estimate = await handlers.get('optionstrat:estimate')(null, {
    ticker: 'SPY',
    legs: [{}]
  });
  assert.strictEqual(estimate.status, 'ok');
  const estimateCall = calls.find(call => call[0] === 'estimateOrder');
  assert.strictEqual(estimateCall[1].instrumentType, 'OPT');
  assert.strictEqual(estimateCall[1].provider, 'optionstrat');
  assert.strictEqual(estimateCall[1].symbol, 'SPY');

  const valuationMissingTicket = await handlers.get('optionstrat:valuation')(null, {
    provider: 'optionstrat',
    symbol: 'SPY'
  });
  assert.deepStrictEqual(valuationMissingTicket, {
    status: 'error',
    provider: 'optionstrat',
    reason: 'ticket required'
  });

  const valuation = await handlers.get('optionstrat:valuation')(null, {
    provider: 'optionstrat',
    ticket: 'deal-1',
    symbol: 'SPY'
  });
  assert.strictEqual(valuation.status, 'ok');
  assert.strictEqual(valuation.ticket, 'deal-1');

  const unsupportedEstimate = await handlers.get('optionstrat:estimate')(null, {
    provider: 'unsupported',
    ticker: 'SPY',
    legs: [{}]
  });
  assert.deepStrictEqual(unsupportedEstimate, {
    status: 'unsupported',
    provider: 'unsupported'
  });

  const unsupportedValuation = await handlers.get('optionstrat:valuation')(null, {
    provider: 'unsupported',
    ticket: 'deal-2',
    symbol: 'SPY'
  });
  assert.deepStrictEqual(unsupportedValuation, {
    status: 'unsupported',
    provider: 'unsupported'
  });

  console.log('optionstratManifestIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
