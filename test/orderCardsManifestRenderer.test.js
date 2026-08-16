const assert = require('assert');
const Module = require('module');

function run() {
  const originalLoad = Module._load;
  const calls = [];
  const fakeRuntime = {
    state: { rows: [] },
    legacyState: {},
    closedCardEventStrategy: null,
    legacyOrderStateApi: {
      getCardState: () => undefined,
      setCardState: () => true,
      clearCardState: () => false,
      setPendingExecLabel: () => true,
      getPendingExecLabel: () => undefined,
      clearPendingExecLabel: () => false,
      markPendingRequest: () => true,
      resolvePendingKey: () => undefined,
      setPendingId: () => true,
      getPendingId: () => undefined,
      getRetryCount: () => undefined,
      findPendingRequestIdByKey: () => undefined,
      clearPendingRequest: () => false,
      clearPendingByKey: () => false,
      markPlacedOrder: () => true,
      getPlacedOrder: () => undefined,
      deletePlacedOrder: () => false,
      resolveTicketKey: () => undefined,
      bindTicket: () => true,
      unbindTicket: () => false,
      listPlacedOrders: () => [],
      clearExecutionStateByKey: () => false
    },
    setClosedCardEventStrategy(strategy) {
      this.closedCardEventStrategy = strategy;
    },
    renderLegacyCards(createCard) {
      return createCard({ ticker: 'AAPL' }, 0);
    },
    mount: (...args) => calls.push(['legacyMount', args]),
    removeRow: () => false,
    resetLegacyRowsForPosition: () => false,
    removeLegacyRowsForPosition: () => false
  };
  let fakeClosedCardEventStrategy = 'ignore';
  let fakeShouldShowSpread = true;
  const fakeOrderCardsRuntime = {
    shouldShowBidAsk: () => true,
    shouldShowSpread: () => fakeShouldShowSpread,
    getInstrumentRefreshMs: () => 777,
    getCardButtons: () => [{ label: 'LIVE', action: 'BL', style: 'bl' }],
    getButtonRows: () => 2,
    getClosedCardEventStrategy: () => fakeClosedCardEventStrategy
  };
  const fakeCard = { type: 'legacy-card' };
  const fakePositionCard = { type: 'regular-position-card' };
  const fakeRenderer = {
    createLegacyOrderCard(args) {
      calls.push(['createLegacyOrderCard', args]);
      return fakeCard;
    },
    createRegularPositionCard(args) {
      calls.push(['createRegularPositionCard', args]);
      return fakePositionCard;
    },
    registerInstrumentHandler: (...args) => {
      calls.push(['registerInstrumentHandler', args]);
      return 'unregister-instrument';
    },
    registerCardTypeHandler: (...args) => {
      calls.push(['registerCardTypeHandler', args]);
      return 'unregister-card-type';
    },
    handlerFor: (...args) => ({ args }),
    handlerForKey: key => ({ key }),
    matchesExistingRow: (...args) => args[0] === args[1],
    scheduleInstantExecution: (...args) => calls.push(['scheduleInstantExecution', args]) || true,
    place: (...args) => calls.push(['place', args]) || Promise.resolve({ status: 'ok' }),
    instrumentTypeHandlers: {},
    cardTypeHandlers: {}
  };

  Module._load = function(request, parent, isMain) {
    const parentPath = String(parent?.filename || '').replace(/\\/g, '/');
    if (parentPath.endsWith('app/services/orderCards/manifest.js') && request === './renderer') {
      return {
        createOrderCardsRenderer(deps) {
          calls.push(['createOrderCardsRenderer', deps]);
          return fakeRenderer;
        }
      };
    }
    if (parentPath.endsWith('app/services/orderCards/manifest.js') && request === './legacyOrderListRuntime') {
      return {
        createLegacyOrderListRuntime(deps) {
          calls.push(['createLegacyOrderListRuntime', deps]);
          return fakeRuntime;
        }
      };
    }
    if (parentPath.endsWith('app/services/orderCards/manifest.js') && request === './rendererConfigRuntime') {
      return {
        createOrderCardsRendererConfigRuntime(deps) {
          calls.push(['createOrderCardsRendererConfigRuntime', deps]);
          onConfigApplied = deps.onConfigApplied;
          return fakeOrderCardsRuntime;
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const manifestPath = '../app/services/orderCards/manifest';
  delete require.cache[require.resolve(manifestPath)];
  const manifest = require(manifestPath);
  Module._load = originalLoad;

  let registeredInstrumentDisplayPolicy = null;
  let registeredCardStateHook = null;
  const testingExtensions = {};
  const rendererLayers = [];
  const rowProviders = [];
  const positionRenderers = {};
  let connectedLegacyAdapter = null;
  const shellGetter = () => false;
  const loadConfig = () => ({});
  const settingsRuntime = { onApply: () => {} };
  const env = { INSTRUMENT_REFRESH_MS: '999' };
  const render = () => {};
  let onConfigApplied = null;

  const rendererContext = {
    loadConfig,
    settingsRuntime,
    env,
    render,
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
    ipcRenderer: { invoke: async () => ({}), on: () => {} },
    cardByKey: () => null,
    setCardState: () => {},
    pendingActionInfo: () => null,
    toast: () => {},
    shakeCard: () => {},
    getGrid: () => ({ appendChild: () => {} }),
    cardStateOrder: {},
    isTerminalCardState: () => false,
    findKeyByTicker: () => null,
    removePositionSnapshotsForRow: () => false,
    positionRemovalHandlerFor: () => null,
    positionMatchesLegacyRow: () => false,
    isRegularPositionSnapshot: () => false,
    shouldFilterLegacyRow: () => false,
    shouldIgnoreLegacyRowForExistingPosition: () => false,
    shouldIgnoreLegacyExecutionEvent: () => false,
    shouldIgnoreLegacyPositionEvent: () => false,
    shouldRemoveLegacyRowForPosition: () => false,
    shouldResetLegacyRowForPosition: () => false,
    forgetInstrument: () => {},
    formatBidAskText: () => '',
    formatSpreadTriple: () => '',
    updateSpreadForTicker: () => {},
    notifyCardRestored: () => {},
    positionKey: position => `position|${position.id}`,
    positionCardTitle: position => position.title,
    btn: () => ({ dataset: {} }),
    dispatchPositionAction: () => {},
    requestRemovePosition: () => {},
    registerInstrumentDisplayPolicy(policy) {
      registeredInstrumentDisplayPolicy = policy;
    },
    registerCardStateHook(hook) {
      registeredCardStateHook = hook;
    },
    registerRendererLayer(layer) {
      rendererLayers.push(layer);
    },
    registerRendererRowProvider(provider) {
      rowProviders.push(provider);
    },
    registerPositionSnapshotHook() {},
    registerPositionRemovedHook() {},
    registerTestingExtension(name, value) {
      testingExtensions[name] = value;
    },
    registerPositionCardRenderer(cardType, renderer) {
      positionRenderers[cardType] = renderer;
    },
    cardRuntime: {
      connectLegacyOrderCardRenderer(adapter) {
        connectedLegacyAdapter = adapter;
      }
    }
  };
  manifest.rendererHandlers[0].register(rendererContext);

  assert.strictEqual(calls[0][0], 'createOrderCardsRendererConfigRuntime');
  assert.strictEqual(calls[0][1].loadConfig, loadConfig);
  assert.strictEqual(calls[0][1].settingsRuntime, settingsRuntime);
  assert.strictEqual(calls[0][1].env, env);
  assert.strictEqual(calls[0][1].render, render);
  assert.strictEqual(typeof calls[0][1].onConfigApplied, 'function');
  assert.strictEqual(typeof registeredInstrumentDisplayPolicy.getInstrumentRefreshMs, 'function');
  assert.strictEqual(registeredInstrumentDisplayPolicy.getInstrumentRefreshMs(), 777);
  assert.strictEqual(registeredInstrumentDisplayPolicy.shouldShowBidAsk(), true);
  assert.strictEqual(registeredInstrumentDisplayPolicy.shouldShowSpread(), true);
  assert.strictEqual(typeof registeredCardStateHook, 'function');
  const restored = [];
  registeredCardStateHook({
    card: { dataset: { ticker: 'AAPL' } },
    updateSpreadForTicker: ticker => restored.push(ticker)
  });
  assert.deepStrictEqual(restored, ['AAPL']);
  fakeShouldShowSpread = false;
  registeredCardStateHook({
    card: { dataset: { ticker: 'MSFT' } },
    updateSpreadForTicker: ticker => restored.push(ticker)
  });
  assert.deepStrictEqual(restored, ['AAPL']);
  fakeShouldShowSpread = true;
  assert.strictEqual(calls[1][0], 'createOrderCardsRenderer');
  assert.strictEqual(connectedLegacyAdapter.renderer, fakeRenderer);
  assert.strictEqual(connectedLegacyAdapter.getRows(), calls[2]?.[1]?.state?.rows || fakeRuntime.state.rows);
  assert.strictEqual(connectedLegacyAdapter.rowKey({ ticker: 'AAPL', event: 'up', time: 1, price: 2 }), 'AAPL|up|1|2');
  assert.strictEqual(typeof connectedLegacyAdapter.setCardState, 'function');
  for (const name of [
    'orderCardsState',
    'setLegacyOrderCardState',
    'orderCardHandlerFor',
    'orderCardHandlerForKey'
  ]) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(rendererContext, name),
      false,
      `orderCards must not publish ${name} in renderer context`
    );
  }
  assert.strictEqual(calls[1][1].shouldShowBidAsk(), true);
  assert.strictEqual(calls[1][1].shouldShowSpread(), true);
  assert.deepStrictEqual(calls[1][1].getCardButtons(), [{ label: 'LIVE', action: 'BL', style: 'bl' }]);
  assert.strictEqual(calls[1][1].getButtonRows(), 2);
  assert.strictEqual(calls[2][0], 'createLegacyOrderListRuntime');
  assert.strictEqual(typeof calls[2][1].matchesExistingOrderRow, 'function');
  assert.strictEqual(typeof calls[2][1].orderCardHandlerForRow, 'function');
  assert.strictEqual(typeof calls[2][1].scheduleOrderCardInstantExecution, 'function');
  assert.strictEqual(fakeRuntime.closedCardEventStrategy, 'ignore');
  fakeClosedCardEventStrategy = 'remove';
  onConfigApplied(fakeOrderCardsRuntime);
  assert.strictEqual(fakeRuntime.closedCardEventStrategy, 'remove');
  assert.strictEqual(typeof rendererLayers[0], 'function');
  rendererLayers[0]({ grid: { appendChild: () => {} } });
  assert.deepStrictEqual(calls.find(call => call[0] === 'createLegacyOrderCard')[1], {
    row: { ticker: 'AAPL' },
    index: 0
  });
  assert.strictEqual(calls.some(call => call[0] === 'legacyMount'), true);
  assert.strictEqual(rowProviders[0](), calls[2][1].state.rows);
  assert.strictEqual(testingExtensions.legacyOrderStateApi.getCardState('x'), undefined);
  assert.strictEqual(testingExtensions.orderCardInstrumentHandlers, fakeRenderer.instrumentTypeHandlers);
  assert.strictEqual(testingExtensions.orderCardTypeHandlers, fakeRenderer.cardTypeHandlers);

  assert.strictEqual(typeof positionRenderers.regular, 'function');
  assert.strictEqual(positionRenderers.regular({ id: 'p1', title: 'AAPL' }), fakePositionCard);
  const positionCall = calls.find(call => call[0] === 'createRegularPositionCard');
  assert.strictEqual(positionCall[1].key, 'position|p1');
  assert.strictEqual(positionCall[1].title, 'AAPL');

  console.log('orderCardsManifestRenderer tests passed');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
