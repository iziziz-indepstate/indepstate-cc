const assert = require('assert');
const {
  initService,
  registerMainApplicationServices,
  registerMainIpcHandlers
} = require('../app/services/optionstrat/manifest');
const { orderPayloadPolicyRegistry } = require('../app/application/execution');

async function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) {
      handlers.set(name, fn);
    }
  };
  const calls = [];
  const closed = [];
  const emitted = [];
  const executionPayloadPolicies = orderPayloadPolicyRegistry();
  const registeredPolicies = [];
  const registerExecutionPayloadPolicy = executionPayloadPolicies.register;
  executionPayloadPolicies.register = (policy) => {
    registeredPolicies.push(policy);
    return registerExecutionPayloadPolicy(policy);
  };
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
    brokerage: {
      registerAdapterFactory(name, factory) {
        calls.push(['registerAdapterFactory', name, factory]);
        return () => true;
      }
    },
    actionBus: {
      emit(name, payload) {
        calls.push(['actionBus', name, payload]);
      }
    },
    positions: {
      registerLegacyGuard() {},
      recordClosed(payload) {
        closed.push(payload);
        return { ok: true };
      }
    },
    events: {
      emit(name, payload) {
        emitted.push([name, payload]);
      }
    },
    executionPayloadPolicies
  };
  initService(servicesApi);
  const adapterRegistration = calls.find(call => call[0] === 'registerAdapterFactory');
  assert.strictEqual(adapterRegistration?.[1], 'optionstrat');
  assert.strictEqual(typeof adapterRegistration?.[2], 'function');
  assert.strictEqual(servicesApi.executionPayloadPolicies, executionPayloadPolicies);
  assert.strictEqual(typeof servicesApi.executionPayloadPolicies?.register, 'function');
  assert.strictEqual(registeredPolicies.length, 1);
  assert.strictEqual(registeredPolicies[0].id, 'optionstrat');
  assert.strictEqual(
    servicesApi.executionPayloadPolicies.policies.some(policy => policy?.id === 'optionstrat'),
    true
  );
  const closeController = servicesApi.executionCloseControllers.find(controller => controller?.id === 'optionstrat');
  assert(closeController);
  assert.strictEqual(typeof closeController.onCancelOrderResult, 'function');

  closeController.onCancelOrderResult({
    providerName: 'optionstrat',
    ticket: 'deal-close-1',
    symbol: 'SPY',
    name: 'LCS',
    result: { status: 'ok', provider: 'optionstrat', valuation: { currentValue: 0 } }
  });
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(closed[0].ticket, 'deal-close-1');
  assert.strictEqual(closed[0].provider, 'optionstrat');
  assert.deepStrictEqual(closed[0].order, { symbol: 'SPY', name: 'LCS' });
  assert.deepStrictEqual(closed[0].trade, { pnlStatus: 'reported', valuation: { currentValue: 0 } });
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0][0], 'order:closed');
  assert.deepStrictEqual(emitted[0][1], {
    provider: 'optionstrat',
    ticket: 'deal-close-1',
    symbol: 'SPY',
    order: { name: 'LCS' },
    result: { status: 'ok', provider: 'optionstrat', valuation: { currentValue: 0 } }
  });

  closeController.onCancelOrderResult({
    providerName: 'paper-optionstrat',
    ticket: 'alias-close-1',
    symbol: 'SPY',
    name: 'Alias LCS',
    result: { status: 'ok', provider: 'optionstrat', raw: { strategy: {} } }
  });
  assert.strictEqual(closed.length, 2);
  assert.strictEqual(closed[1].ticket, 'alias-close-1');
  assert.strictEqual(closed[1].provider, 'paper-optionstrat');
  assert.deepStrictEqual(emitted[1][1], {
    provider: 'paper-optionstrat',
    ticket: 'alias-close-1',
    symbol: 'SPY',
    order: { name: 'Alias LCS' },
    result: { status: 'ok', provider: 'paper-optionstrat', raw: { strategy: {} } }
  });

  closeController.onCancelOrderResult({
    providerName: 'paper-optionstrat-raw',
    ticket: 'alias-close-2',
    symbol: 'QQQ',
    result: { status: 'ok', provider: 'paper-optionstrat-raw', raw: { strategy: {} } }
  });
  assert.strictEqual(closed.length, 3);
  assert.strictEqual(closed[2].provider, 'paper-optionstrat-raw');
  assert.deepStrictEqual(emitted[2][1].order, {});
  assert.strictEqual(emitted[2][1].result.provider, 'paper-optionstrat-raw');

  closeController.onCancelOrderResult({
    providerName: 'simulated',
    ticket: 'sim-close-1',
    symbol: 'SPY',
    name: 'ignored',
    result: { status: 'ok', provider: 'simulated' }
  });
  closeController.onCancelOrderResult({
    providerName: 'optionstrat',
    symbol: 'SPY',
    result: { status: 'ok', provider: 'optionstrat' }
  });
  closeController.onCancelOrderResult({
    ticket: 'missing-provider',
    symbol: 'SPY',
    result: { status: 'ok', raw: { strategy: {} } }
  });
  assert.strictEqual(closed.length, 3);
  assert.strictEqual(emitted.length, 3);

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
    resolveProviderName: () => 'optionstrat'
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
  assert.strictEqual(estimateCall[1].ticker, 'SPY');
  assert.strictEqual(estimateCall[1].type, 'strategy');

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
