const assert = require('assert');
const { createExecutionApplicationService } = require('../app/application/execution');
const { createLevelOrderExecutionController } = require('../app/services/levelOrder');

async function run() {
  const logs = [];
  const renderer = [];
  const emitted = [];
  const placedOrders = [];
  const positionCalls = [];
  const adapterGetCalls = [];
  const wireCalls = [];
  const pendingIndex = new Map();
  let placeResult = { status: 'ok', provider: 'simulated', providerOrderId: 'ticket-1' };
  let quote = { price: 100, bid: 99, ask: 101 };

  const service = createExecutionApplicationService({
    getAdapter: (provider) => {
      adapterGetCalls.push(provider);
      return {
      placeOrder: async (order) => {
        placedOrders.push(order);
        return placeResult;
      }
      };
    },
    wireAdapter: (...args) => wireCalls.push(args),
    instrumentInfo: {
      get: async () => ({ quote, metadata: { quantityStep: 1, contractSize: 10 } }),
      getTickSizeResolution: () => ({ tickSize: 1, source: 'test' })
    },
    orderCalc: {
      qty: ({ riskUsd, stopPts, tickSize }) => riskUsd / (stopPts * tickSize)
    },
    tradeRules: { validate: () => ({ ok: true }) },
    events: { emit: (name, payload) => emitted.push({ name, payload }) },
    positions: {
      handle: (cmd) => {
        positionCalls.push(['handle', cmd]);
        return { ok: true, position: { id: cmd.positionId }, events: [], integrationCommands: [] };
      },
      createAndOpen: (cmd) => positionCalls.push(['createAndOpen', cmd]),
      recordPlaced: (cmd) => positionCalls.push(['recordPlaced', cmd]),
      recordRejected: (cmd) => positionCalls.push(['recordRejected', cmd]),
      recordFailed: (cmd) => positionCalls.push(['recordFailed', cmd])
    },
    appendJsonl: (_file, rec) => logs.push(rec),
    execLog: 'memory',
    nowTs: () => 1000,
    sendToRenderer: (channel, payload) => renderer.push({ channel, payload }),
    trackerPending: new Map(),
    trackerIndex: new Map(),
    pendingIndex,
    resolveOrderProviderName: () => 'simulated',
    resolveProviderName: () => 'simulated',
    providerCanResolveRiskQty: () => false,
    cardControllers: [
      createLevelOrderExecutionController()
    ]
  });

  const previewPayload = {
    ticker: 'ADAUSDT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: { qty: 1, riskUsd: 10, stopPts: 5 }
  };
  const preview = await service.previewPlaceOrder(previewPayload);
  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.status, 'ok');
  assert.strictEqual(preview.provider, 'simulated');
  assert.strictEqual(preview.order.side, 'buy');
  assert.strictEqual(preview.order.type, 'limit');
  assert.strictEqual(preview.order.qty, 2);
  assert.strictEqual(preview.order.tickSize, 1);
  assert.strictEqual(preview.order.meta.quantityStep, 1);
  assert.strictEqual(preview.order.meta.requestId, undefined);
  assert.strictEqual(preview.order.meta.cid, undefined);
  assert.strictEqual(preview.order.clientOrderId, undefined);
  assert.deepStrictEqual(preview.quote, { price: 100, bid: 99, ask: 101 });
  assert.deepStrictEqual(preview.instrument, {
    symbol: 'ADAUSDT',
    instrumentType: 'EQ',
    tickSize: 1,
    quantityStep: 1,
    contractSize: 10
  });
  assert.deepStrictEqual(preview.errors, []);
  assert.deepStrictEqual(previewPayload.meta, { qty: 1, riskUsd: 10, stopPts: 5 });
  assert.strictEqual(adapterGetCalls.length, 0);
  assert.strictEqual(wireCalls.length, 0);
  assert.strictEqual(placedOrders.length, 0);
  assert.strictEqual(positionCalls.length, 0);
  assert.strictEqual(renderer.length, 0);
  assert.strictEqual(emitted.length, 0);
  assert.strictEqual(logs.length, 0);

  const originalPreviewPlaceOrder = service.previewPlaceOrder.bind(service);
  let queuePreviewCalls = 0;
  service.previewPlaceOrder = async (...args) => {
    queuePreviewCalls += 1;
    return originalPreviewPlaceOrder(...args);
  };
  const ok = await service.queuePlaceOrder({
    ticker: 'ADAUSDT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: { requestId: 'req-1', cid: 'cid-1', qty: 1, riskUsd: 10, stopPts: 5 }
  });
  assert.strictEqual(queuePreviewCalls, 1);
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(placedOrders.length, 1);
  assert.strictEqual(placedOrders[0].symbol, 'ADAUSDT');
  assert.strictEqual(placedOrders[0].side, 'buy');
  assert.strictEqual(placedOrders[0].type, 'limit');
  assert.match(placedOrders[0].comment, /cid:cid-1/);
  assert.strictEqual(renderer.some(item => item.channel === 'execution:result'), true);
  assert.strictEqual(emitted.some(item => item.name === 'order:placed'), true);
  assert.strictEqual(positionCalls.some(([name]) => name === 'createAndOpen'), true);
  assert.strictEqual(positionCalls.some(([name]) => name === 'recordPlaced'), true);

  positionCalls.length = 0;
  placedOrders.length = 0;
  placeResult = { status: 'ok', provider: 'simulated', providerOrderId: 'ticket-existing-position' };
  const existingPositionOrder = await service.queuePlaceOrder({
    ticker: 'MSFT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: { requestId: 'req-existing-position', cid: 'cid-existing-position', positionId: 'pos-reg-existing', qty: 1, riskUsd: 10, stopPts: 5 }
  });
  assert.strictEqual(existingPositionOrder.status, 'ok');
  assert.strictEqual(positionCalls.some(([name]) => name === 'createAndOpen'), false);
  assert(positionCalls.some(([name, cmd]) => name === 'handle' && cmd.type === 'position.open' && cmd.positionId === 'pos-reg-existing'));
  assert(positionCalls.some(([name, cmd]) => name === 'recordPlaced' && cmd.positionId === 'pos-reg-existing'));

  quote = null;
  placedOrders.length = 0;
  const sideEffectsBeforeRejectedPreview = {
    adapters: adapterGetCalls.length,
    wired: wireCalls.length,
    positions: positionCalls.length,
    renderer: renderer.length,
    emitted: emitted.length,
    logs: logs.length
  };
  const noQuotePreview = await service.previewPlaceOrder({
    ticker: 'ADAUSDT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: { qty: 1, riskUsd: 10, stopPts: 5 }
  });
  assert.strictEqual(noQuotePreview.ok, false);
  assert.strictEqual(noQuotePreview.status, 'rejected');
  assert.strictEqual(noQuotePreview.reason, 'No quote');
  assert.deepStrictEqual(noQuotePreview.errors, [{ code: 'QUOTE_UNAVAILABLE', field: 'quote', message: 'No quote' }]);
  assert.strictEqual(adapterGetCalls.length, sideEffectsBeforeRejectedPreview.adapters);
  assert.strictEqual(wireCalls.length, sideEffectsBeforeRejectedPreview.wired);
  assert.strictEqual(positionCalls.length, sideEffectsBeforeRejectedPreview.positions);
  assert.strictEqual(renderer.length, sideEffectsBeforeRejectedPreview.renderer);
  assert.strictEqual(emitted.length, sideEffectsBeforeRejectedPreview.emitted);
  assert.strictEqual(logs.length, sideEffectsBeforeRejectedPreview.logs);
  const noQuote = await service.queuePlaceOrder({
    ticker: 'ADAUSDT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: { requestId: 'req-2', cid: 'cid-2', qty: 1, riskUsd: 10, stopPts: 5 }
  });
  assert.strictEqual(noQuote.status, 'rejected');
  assert.strictEqual(noQuote.reason, 'No quote');
  assert.strictEqual(noQuote.errors[0].code, 'QUOTE_UNAVAILABLE');
  assert.strictEqual(placedOrders.length, 0);

  quote = { price: 100 };
  placeResult = { status: 'ok', provider: 'simulated', providerOrderId: 'pending:cid-3' };
  const pending = await service.queuePlaceOrder({
    ticker: 'ADAUSDT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: { requestId: 'req-3', cid: 'cid-3', qty: 1, riskUsd: 10, stopPts: 5 }
  });
  assert.strictEqual(pending.status, 'ok');
  assert.strictEqual(pending.providerOrderId, 'pending:cid-3');
  assert.strictEqual(pendingIndex.has('cid-3'), true);
  assert.strictEqual(renderer.some(item => item.channel === 'execution:pending' && item.payload.pendingId === 'cid-3'), true);

  positionCalls.length = 0;
  placedOrders.length = 0;
  placeResult = { status: 'ok', provider: 'simulated', providerOrderId: 'ticket-level-child' };
  const levelChild = await service.queuePlaceOrder({
    ticker: 'ADAUSDT',
    kind: 'BL',
    price: 100,
    instrumentType: 'EQ',
    meta: {
      requestId: 'parent-1_1',
      parentRequestId: 'parent-1',
      cid: 'cid-level-child',
      qty: 1,
      fixedQty: true,
      strategy: 'limitBidTrade',
      riskUsd: 10,
      stopPts: 5
    }
  });
  assert.strictEqual(levelChild.status, 'ok');
  assert.strictEqual(placedOrders.length, 1);
  assert.strictEqual(positionCalls.some(([name]) => name === 'createAndOpen'), false);
  assert.strictEqual(positionCalls.some(([name]) => name === 'recordPlaced'), false);

  const policyPlacedOrders = [];
  let policyOrderCalcCalls = 0;
  let policyTradeRuleCalls = 0;
  let policyInstrumentForceQuote;
  const policyService = createExecutionApplicationService({
    getAdapter: () => ({
      placeOrder: async (order) => {
        policyPlacedOrders.push(order);
        return { status: 'ok', provider: 'simulated', providerOrderId: 'policy-ticket-1' };
      }
    }),
    wireAdapter: () => {},
    instrumentInfo: {
      get: async (_context, options) => {
        policyInstrumentForceQuote = options?.forceQuote;
        return { quote: null, metadata: { quantityStep: 1 } };
      },
      getTickSizeResolution: () => ({ tickSize: 1, source: 'test' })
    },
    orderCalc: {
      qty: () => {
        policyOrderCalcCalls += 1;
        return 999;
      }
    },
    tradeRules: {
      validate: () => {
        policyTradeRuleCalls += 1;
        return { ok: false, reason: 'should not run' };
      }
    },
    events: { emit: () => {} },
    positions: {
      createAndOpen: () => {},
      recordPlaced: () => {},
      recordRejected: () => {},
      recordFailed: () => {}
    },
    appendJsonl: () => {},
    execLog: 'memory',
    nowTs: () => 2000,
    sendToRenderer: () => {},
    trackerPending: new Map(),
    trackerIndex: new Map(),
    pendingIndex: new Map(),
    resolveOrderProviderName: () => 'simulated',
    resolveProviderName: () => 'simulated',
    providerCanResolveRiskQty: () => false,
    orderPayloadPolicies: [{
      id: 'policy-test',
      matchesPayload: payload => payload?.event === 'policy-test',
      matchesOrder: order => order?.meta?.policyTest === true,
      normalizePayload: payload => ({
        instrumentType: 'EQ',
        symbol: payload.ticker,
        provider: 'simulated',
        side: 'buy',
        type: 'market',
        qty: 1,
        price: 0,
        sl: 0,
        meta: {
          policyTest: true,
          requestId: 'policy-req-1',
          cid: 'policy-cid-1',
          riskUsd: 10,
          stopPts: 5
        }
      }),
      validateOrder: () => ({ ok: true }),
      executionOptions: () => ({
        requiresQuote: false,
        usesRiskSizing: false,
        usesTradeRules: false
      })
    }]
  });
  const policyPreview = await policyService.previewPlaceOrder({ event: 'policy-test', ticker: 'PLUGIN' });
  assert.strictEqual(policyPreview.ok, true);
  assert.strictEqual(policyPreview.order.qty, 1);
  assert.strictEqual(policyInstrumentForceQuote, false);
  assert.strictEqual(policyOrderCalcCalls, 0);
  assert.strictEqual(policyTradeRuleCalls, 0);
  assert.strictEqual(policyPlacedOrders.length, 0);

  const policyResult = await policyService.queuePlaceOrder({ event: 'policy-test', ticker: 'PLUGIN' });
  assert.strictEqual(policyResult.status, 'ok');
  assert.strictEqual(policyInstrumentForceQuote, false);
  assert.strictEqual(policyOrderCalcCalls, 0);
  assert.strictEqual(policyTradeRuleCalls, 0);
  assert.strictEqual(policyPlacedOrders.length, 1);
  assert.strictEqual(policyPlacedOrders[0].qty, 1);

  console.log('executionApplicationService tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
