const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping rendererExtensionRegistry test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const handlers = {};
  const ipcRenderer = {
    on: (channel, handler) => { handlers[channel] = handler; },
    invoke: async channel => {
      if (channel === 'positions:list') return [];
      if (channel === 'settings:get') return { autoscroll: true };
      if (channel === 'settings:list') return [];
      if (channel === 'settings:restart-status') return [];
      if (channel === 'actions-bus:list') return [];
      if (channel === 'actions-bus:set-enabled') return [];
      return {};
    }
  };

  const spreadUpdates = [];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const parentPath = String(parent?.filename || '').replace(/\\/g, '/');
    const normalizedRequest = String(request).replace(/\\/g, '/');
    if (request === 'electron') return { ipcRenderer };
    if (parentPath.endsWith('app/renderer.js') && request === './config/load') {
      return name => name === '../services/settings/config/services.json' ? ['services/orderCards'] : {};
    }
    if (parentPath.endsWith('app/renderer.js') && request === './services/instrumentInfo/renderer') {
      return {
        createInstrumentInfoRenderer() {
          return {
            instrumentInfo: new Map(),
            instrumentInfoFor: () => null,
            ensureInstrument: () => {},
            forgetInstrument: () => {},
            tickSize: () => 0.01,
            formatBidAskText: () => '',
            formatSpreadTriple: () => '',
            updateSpreadForTicker: ticker => { spreadUpdates.push(ticker); },
            revalidateCardsForTicker: () => {},
            startPeriodicRefresh: () => {},
            trackInstrument: () => {},
            untrackInstrument: () => {}
          };
        }
      };
    }
    if (normalizedRequest.endsWith('/app/services/orderCards/manifest.js')) {
      return {
        rendererHandlers: [{
          register(context = {}) {
            const runtime = context.cardRuntime;
            runtime.registerCardView('test-view', () => document.createElement('input'));
            runtime.registerCardControl('test-control', () => ({}));
            runtime.registerCardShape('test-shape', ({ position, key, body }) => {
              const card = document.createElement('div');
              card.className = 'card position-card';
              card.dataset.rowkey = key;
              card.dataset.positionId = position.id;
              card.dataset.ticker = position.ticker;
              card.appendChild(body);
              const status = document.createElement('span');
              status.className = 'card__status';
              card.appendChild(status);
              return card;
            });
            runtime.registerCardType({
              type: 'regular',
              view: 'test-view',
              controls: ['test-control'],
              shape: 'test-shape'
            });
          }
        }]
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM('<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button><div id="settings-restart-required"></div></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  const rendererPath = '../app/renderer.js';
  delete require.cache[require.resolve(rendererPath)];
  const renderer = require(rendererPath);
  Module._load = originalLoad;
  const t = renderer.__testing;

  assert.strictEqual(t.getInstrumentRefreshMs(), 1000);
  assert.strictEqual(t.shouldShowBidAsk(), false);
  assert.strictEqual(t.shouldShowSpread(), false);
  handlers['positions:changed'](null, {
    event: { type: 'position.created' },
    position: {
      id: 'pos-test',
      state: 'draft',
      ticker: 'TST',
      card: { type: 'regular', actions: [], data: { ticker: 'TST' } }
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  const key = 'position|pos-test';

  t.registerCardStateHook(({ card, updateSpreadForTicker }) => {
    if (t.shouldShowSpread()) updateSpreadForTicker(card.dataset.ticker);
  });
  t.setCardState(key, null);
  assert.deepStrictEqual(spreadUpdates, []);

  const unregisterPolicy = t.registerInstrumentDisplayPolicy({
    getInstrumentRefreshMs: () => 2500,
    shouldShowBidAsk: () => true,
    shouldShowSpread: () => true
  });
  assert.strictEqual(t.getInstrumentRefreshMs(), 2500);
  assert.strictEqual(t.shouldShowBidAsk(), true);
  assert.strictEqual(t.shouldShowSpread(), true);
  t.setCardState(key, null);
  assert.deepStrictEqual(spreadUpdates, ['TST']);

  unregisterPolicy();
  assert.strictEqual(t.getInstrumentRefreshMs(), 1000);
  assert.strictEqual(t.shouldShowBidAsk(), false);
  assert.strictEqual(t.shouldShowSpread(), false);

  console.log('rendererExtensionRegistry tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
