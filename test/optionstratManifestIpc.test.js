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
  const registeredLifecycleEnrichers = [];
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
      },
      registerExecutionProviderDefaults(extension) {
        calls.push(['registerExecutionProviderDefaults', extension]);
        return {};
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
    outboundWebhooks: {
      registerLifecycleEnricher(enricher) {
        registeredLifecycleEnrichers.push(enricher);
        return () => true;
      }
    },
    executionPayloadPolicies
  };
  initService(servicesApi);
  const adapterRegistration = calls.find(call => call[0] === 'registerAdapterFactory');
  assert.strictEqual(adapterRegistration?.[1], 'optionstrat');
  assert.strictEqual(typeof adapterRegistration?.[2], 'function');
  const executionDefaultsRegistration = calls.find(call => call[0] === 'registerExecutionProviderDefaults');
  assert.strictEqual(executionDefaultsRegistration?.[1]?.routingDefaults?.byInstrumentType?.OPT, 'optionstrat');
  assert.strictEqual(executionDefaultsRegistration?.[1]?.providers?.optionstrat?.adapter, 'optionstrat');
  assert.strictEqual(
    executionDefaultsRegistration?.[1]?.settingsDescriptor?.options?.providers?.optionstrat?.timeoutMs?.type,
    'number'
  );
  assert.strictEqual(servicesApi.executionPayloadPolicies, executionPayloadPolicies);
  assert.strictEqual(typeof servicesApi.executionPayloadPolicies?.register, 'function');
  assert.strictEqual(registeredPolicies.length, 1);
  assert.strictEqual(registeredPolicies[0].id, 'optionstrat');
  assert.strictEqual(
    servicesApi.executionPayloadPolicies.policies.some(policy => policy?.id === 'optionstrat'),
    true
  );
  assert.strictEqual(registeredLifecycleEnrichers.length, 1);
  assert.strictEqual(typeof registeredLifecycleEnrichers[0], 'function');
  const enrichOptionLifecycle = registeredLifecycleEnrichers[0];
  const openEnriched = { provider: 'optionstrat', legs: [
    { option: 'CALL', side: 'buy', strike: 7500, quantity: 1 },
    { option: 'CALL', side: 'sell', strike: 7510, quantity: 1 }
  ] };
  const openPatch = enrichOptionLifecycle({
    eventName: 'order:placed',
    payload: {
      order: { provider: 'optionstrat', symbol: 'SPXW' },
      result: {
        status: 'ok',
        provider: 'optionstrat',
        raw: {
          strategy: {
            items: [
              { symbol: '.SPXW260531C7500', basis: 1.2, quantity: 1 },
              { symbol: '.SPXW260531C7510', basis: 0.45, quantity: -1 }
            ]
          }
        }
      }
    },
    enriched: openEnriched
  });
  assert.strictEqual(openPatch.legsText, '+1C7500/-1C7510');
  assert.strictEqual(openPatch.legsPair, '7500/7510');
  assert.strictEqual(openPatch.optionOpenLegsText, '+1C7500@1.20/-1C7510@0.45');
  assert.strictEqual(openPatch.optionOpenNetPrice, 0.75);

  const closePatch = enrichOptionLifecycle({
    eventName: 'order:closed',
    payload: {
      provider: 'optionstrat',
      result: {
        status: 'ok',
        provider: 'optionstrat',
        valuation: {
          change: 600,
          legs: [
            { symbol: '.SPXW260531C7500', basis: 1.2, current: 1.75, quantity: 1 },
            { symbol: '.SPXW260531C7510', basis: 0.45, current: 0.3, quantity: -1 }
          ]
        },
        raw: {
          strategy: {
            items: [
              { symbol: '.SPXW260531C7500', basis: 1.2, close: 1.75, quantity: 1 },
              { symbol: '.SPXW260531C7510', basis: 0.45, close: 0.3, quantity: -1 }
            ]
          }
        }
      }
    },
    enriched: { provider: 'optionstrat' }
  });
  assert.strictEqual(closePatch.optionCloseLegsText, '+1C7500@1.75/-1C7510@0.30');
  assert.strictEqual(closePatch.optionCloseNetPrice, 1.45);
  assert.strictEqual(closePatch.optionPnl, 600);
  assert.deepStrictEqual(enrichOptionLifecycle({
    eventName: 'order:placed',
    payload: { result: { status: 'rejected', provider: 'optionstrat', reason: 'no account' } },
    enriched: { provider: 'optionstrat' }
  }), {});
  assert.deepStrictEqual(enrichOptionLifecycle({
    eventName: 'order:closed',
    payload: { result: { status: 'error', provider: 'optionstrat', reason: 'missing strategy' } },
    enriched: { provider: 'optionstrat' }
  }), {});
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
