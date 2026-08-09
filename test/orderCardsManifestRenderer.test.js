const assert = require('assert');
const Module = require('module');

function run() {
  const originalLoad = Module._load;
  const calls = [];
  const fakeRuntime = {
    state: { rows: [] },
    legacyState: {},
    closedCardEventStrategy: null,
    setClosedCardEventStrategy(strategy) {
      this.closedCardEventStrategy = strategy;
    }
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

  let legacyRegistration = null;
  let registeredInstrumentDisplayPolicy = null;
  let registeredCardStateHook = null;
  const positionRenderers = {};
  const shellGetter = () => false;
  const orderCardsDeps = {
    marker: 'order-cards-deps',
    shouldShowBidAsk: shellGetter,
    shouldShowSpread: shellGetter,
    getCardButtons: () => [],
    getButtonRows: () => 1
  };
  const legacyOrderListDeps = { marker: 'legacy-order-list-deps' };
  const loadConfig = () => ({});
  const settingsRuntime = { onApply: () => {} };
  const env = { INSTRUMENT_REFRESH_MS: '999' };
  const render = () => {};
  let onConfigApplied = null;

  manifest.rendererHandlers[0].register({
    loadConfig,
    settingsRuntime,
    env,
    render,
    orderCardsDeps,
    legacyOrderListDeps,
    positionKey: position => `position|${position.id}`,
    positionCardTitle: position => position.title,
    btn: () => ({ dataset: {} }),
    dispatchPositionAction: () => {},
    requestRemovePosition: () => {},
    registerLegacyOrderCardsRuntime(registration) {
      legacyRegistration = registration;
    },
    registerInstrumentDisplayPolicy(policy) {
      registeredInstrumentDisplayPolicy = policy;
    },
    registerCardStateHook(hook) {
      registeredCardStateHook = hook;
    },
    registerPositionCardRenderer(cardType, renderer) {
      positionRenderers[cardType] = renderer;
    }
  });

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
  assert.strictEqual(calls[1][1].marker, orderCardsDeps.marker);
  assert.notStrictEqual(calls[1][1].shouldShowBidAsk, shellGetter);
  assert.strictEqual(calls[1][1].shouldShowBidAsk(), true);
  assert.strictEqual(calls[1][1].shouldShowSpread(), true);
  assert.deepStrictEqual(calls[1][1].getCardButtons(), [{ label: 'LIVE', action: 'BL', style: 'bl' }]);
  assert.strictEqual(calls[1][1].getButtonRows(), 2);
  assert.strictEqual(calls[2][0], 'createLegacyOrderListRuntime');
  assert.strictEqual(calls[2][1].marker, legacyOrderListDeps.marker);
  assert.strictEqual(typeof calls[2][1].matchesExistingOrderRow, 'function');
  assert.strictEqual(typeof calls[2][1].orderCardHandlerForRow, 'function');
  assert.strictEqual(typeof calls[2][1].scheduleOrderCardInstantExecution, 'function');

  assert.strictEqual(legacyRegistration.runtime, fakeRuntime);
  assert.strictEqual(legacyRegistration.orderCardsRuntime, fakeOrderCardsRuntime);
  assert.strictEqual(fakeRuntime.closedCardEventStrategy, 'ignore');
  fakeClosedCardEventStrategy = 'remove';
  onConfigApplied(fakeOrderCardsRuntime);
  assert.strictEqual(fakeRuntime.closedCardEventStrategy, 'remove');
  assert.strictEqual(legacyRegistration.createCard({ ticker: 'AAPL' }, 2), fakeCard);
  assert.deepStrictEqual(calls.find(call => call[0] === 'createLegacyOrderCard')[1], {
    row: { ticker: 'AAPL' },
    index: 2
  });
  assert.strictEqual(legacyRegistration.registerInstrumentHandler('EQ', {}), 'unregister-instrument');
  assert.strictEqual(legacyRegistration.registerCardTypeHandler('regular', {}), 'unregister-card-type');
  assert.strictEqual(legacyRegistration.instrumentTypeHandlers, fakeRenderer.instrumentTypeHandlers);
  assert.strictEqual(legacyRegistration.cardTypeHandlers, fakeRenderer.cardTypeHandlers);

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
