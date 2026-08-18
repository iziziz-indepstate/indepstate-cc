const assert = require('assert');
const manifest = require('../app/services/orderCards/manifest');

function run() {
  const runtimeCalls = [];
  let displayPolicy;
  let cardStateHook;
  const stateApi = {
    markPendingRequest: () => true,
    setPendingExecLabel: () => true,
    setPendingId: () => true
  };
  const context = {
    loadConfig: () => ({
      showBidAsk: true,
      showSpread: true,
      instrumentRefreshMs: 777,
      buttons: [{ label: 'LIVE', action: 'BL', style: 'bl' }],
      buttonRows: 2
    }),
    settingsRuntime: { onApply: () => {} },
    env: {},
    render: () => {},
    el: () => ({}),
    inputNumber: () => ({}),
    uiState: new Map(),
    orderCalc: {},
    priceToPoints: () => 1,
    normNum: Number,
    isPos: () => true,
    isSL: () => true,
    tickSize: () => 1,
    instrumentInfoFor: () => ({}),
    tradeRules: { validate: () => ({ ok: true }) },
    markTouched: () => {},
    detectInstrumentType: () => 'EQ',
    rowKey: row => `${row.ticker}|${row.event}|${row.time}|${row.price}`,
    ipcRenderer: { invoke: async () => ({}) },
    cardByKey: () => null,
    cardStateApi: stateApi,
    setCardState: () => {},
    pendingActionInfo: () => null,
    toast: () => {},
    shakeCard: () => {},
    btn: () => ({}),
    registerInstrumentDisplayPolicy(policy) { displayPolicy = policy; },
    registerCardStateHook(hook) { cardStateHook = hook; },
    cardRuntime: {
      stateApi,
      registerCardType(definition) { runtimeCalls.push(['type', definition]); },
      registerCardView(name, renderer) { runtimeCalls.push(['view', name, renderer]); },
      registerCardControl(name, factory) { runtimeCalls.push(['control', name, factory]); },
      registerCardShape(name, composer) { runtimeCalls.push(['shape', name, composer]); }
    }
  };

  manifest.rendererHandlers[0].register(context);
  assert.strictEqual(displayPolicy.getInstrumentRefreshMs(), 777);
  assert.strictEqual(displayPolicy.shouldShowBidAsk(), true);
  assert.strictEqual(displayPolicy.shouldShowSpread(), true);
  const restored = [];
  cardStateHook({ card: { dataset: { ticker: 'AAPL' } }, updateSpreadForTicker: ticker => restored.push(ticker) });
  assert.deepStrictEqual(restored, ['AAPL']);

  assert(runtimeCalls.some(call => call[0] === 'view' && call[1] === 'position-data-grid'));
  assert(runtimeCalls.some(call => call[0] === 'view' && call[1] === 'regular-position-view'));
  assert(runtimeCalls.some(call => call[0] === 'control' && call[1] === 'regular-position-actions'));
  assert(runtimeCalls.some(call => call[0] === 'shape' && call[1] === 'regular-position-card'));
  const regular = runtimeCalls.find(call => call[0] === 'type' && call[1].type === 'regular')[1];
  assert.strictEqual(regular.view, 'regular-position-view');
  assert.deepStrictEqual(regular.controls, ['regular-position-actions']);
  assert.strictEqual(regular.shape, 'regular-position-card');

  for (const removedName of [
    'regular-order-legacy-card',
    'standard-remove',
    'standard-retry',
    'standard-action-buttons'
  ]) {
    assert.strictEqual(runtimeCalls.some(call => call[1] === removedName), false);
  }

  console.log('orderCardsManifestRenderer tests passed');
}

run();
