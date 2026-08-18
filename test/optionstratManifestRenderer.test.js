const assert = require('assert');
const Module = require('module');

async function run() {
  const originalLoad = Module._load;
  const rendererCalls = [];
  const runtimeCalls = [];
  const handlers = new Map();
  let rendererDeps;
  let renderCount = 0;

  Module._load = function(request, parent, isMain) {
    if (request === './renderer' && String(parent?.filename || '').replace(/\\/g, '/').endsWith('app/services/optionstrat/manifest.js')) {
      return {
        createOptionStratRenderer(deps) {
          rendererDeps = deps;
          return {
            createOptionPositionView: () => ({ type: 'option-view' }),
            createOptionSnapshotActionsControl: () => ({ type: 'option-actions' }),
            createOptionPositionCard: () => ({ type: 'option-card' }),
            setValuationRefreshMs(ms) {
              rendererCalls.push(['setValuationRefreshMs', ms]);
              return Number(ms);
            },
            setDisplayFields(fields) {
              rendererCalls.push(['setDisplayFields', fields]);
              return fields;
            },
            startValuationRefresh() {
              rendererCalls.push(['startValuationRefresh']);
            }
          };
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const manifestPath = '../app/services/optionstrat/manifest';
  delete require.cache[require.resolve(manifestPath)];
  const manifest = require(manifestPath);
  Module._load = originalLoad;

  const positions = [];
  const getPositionSnapshots = () => positions;
  const positionKey = position => `position|${position.id}`;
  manifest.rendererHandlers[0].register({
    ipcRenderer: {
      invoke: async (channel, payload) => channel === 'settings:get' && payload === 'optionstrat'
        ? { valuationRefreshMs: 7000, displayFields: { pl: true } }
        : {}
    },
    el: () => ({}),
    render: () => { renderCount += 1; },
    getPositionSnapshots,
    positionKey,
    cardRuntime: {
      registerCardType(definition) { runtimeCalls.push(['type', definition]); },
      registerCardView(name, renderer) { runtimeCalls.push(['view', name, renderer]); },
      registerCardControl(name, factory) { runtimeCalls.push(['control', name, factory]); },
      registerCardShape(name, composer) { runtimeCalls.push(['shape', name, composer]); }
    },
    settingsRuntime: {
      onApply(name, fn) { handlers.set(name, fn); }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(rendererDeps.getPositions, getPositionSnapshots);
  assert.strictEqual(rendererDeps.positionKey, positionKey);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rendererDeps, 'legacyRows'), false);
  assert(rendererCalls.some(call => call[0] === 'setValuationRefreshMs' && call[1] === 7000));
  assert(rendererCalls.some(call => call[0] === 'setDisplayFields' && call[1].pl === true));
  assert(rendererCalls.some(call => call[0] === 'startValuationRefresh'));

  for (const type of ['option', 'optionstrat']) {
    const definition = runtimeCalls.find(call => call[0] === 'type' && call[1].type === type)?.[1];
    assert(definition);
    assert.strictEqual(definition.view, 'option-snapshot-payoff-valuation');
    assert.deepStrictEqual(definition.controls, ['option-snapshot-actions']);
    assert.strictEqual(definition.shape, 'option-snapshot-position-card');
  }
  assert(runtimeCalls.some(call => call[0] === 'view' && call[1] === 'option-snapshot-payoff-valuation'));
  assert(runtimeCalls.some(call => call[0] === 'control' && call[1] === 'option-snapshot-actions'));
  assert(runtimeCalls.some(call => call[0] === 'shape' && call[1] === 'option-snapshot-position-card'));
  assert.strictEqual(runtimeCalls.some(call => String(call[1]).includes('legacy')), false);

  handlers.get('optionstrat')({ config: { valuationRefreshMs: 9000, displayFields: { value: false } } });
  assert(rendererCalls.some(call => call[0] === 'setValuationRefreshMs' && call[1] === 9000));
  assert(rendererCalls.some(call => call[0] === 'setDisplayFields' && call[1].value === false));
  assert.strictEqual(renderCount, 1);

  console.log('optionstratManifestRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
