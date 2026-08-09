const assert = require('assert');
const Module = require('module');

function run() {
  const originalLoad = Module._load;
  const calls = [];
  const fakeRuntime = {
    state: { rows: [] },
    legacyState: {}
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
    return originalLoad(request, parent, isMain);
  };

  const manifestPath = '../app/services/orderCards/manifest';
  delete require.cache[require.resolve(manifestPath)];
  const manifest = require(manifestPath);
  Module._load = originalLoad;

  let legacyRegistration = null;
  const positionRenderers = {};
  const orderCardsDeps = { marker: 'order-cards-deps' };
  const legacyOrderListDeps = { marker: 'legacy-order-list-deps' };

  manifest.rendererHandlers[0].register({
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
    registerPositionCardRenderer(cardType, renderer) {
      positionRenderers[cardType] = renderer;
    }
  });

  assert.strictEqual(calls[0][0], 'createOrderCardsRenderer');
  assert.strictEqual(calls[0][1], orderCardsDeps);
  assert.strictEqual(calls[1][0], 'createLegacyOrderListRuntime');
  assert.strictEqual(calls[1][1].marker, legacyOrderListDeps.marker);
  assert.strictEqual(typeof calls[1][1].matchesExistingOrderRow, 'function');
  assert.strictEqual(typeof calls[1][1].orderCardHandlerForRow, 'function');
  assert.strictEqual(typeof calls[1][1].scheduleOrderCardInstantExecution, 'function');

  assert.strictEqual(legacyRegistration.runtime, fakeRuntime);
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
