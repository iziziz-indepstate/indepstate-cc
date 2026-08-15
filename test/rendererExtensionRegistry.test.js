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
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch) => {
      if (ch === 'settings:get') return { autoscroll: true };
      if (ch === 'settings:list') return [];
      if (ch === 'settings:restart-status') return [];
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      return {};
    }
  };

  let spreadUpdates = [];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const parentPath = String(parent?.filename || '').replace(/\\/g, '/');
    const normalizedRequest = String(request).replace(/\\/g, '/');
    if (request === 'electron') return { ipcRenderer };
    if (parentPath.endsWith('app/renderer.js') && request === './config/load') {
      return (name) => {
        if (name === '../services/settings/config/services.json') return ['services/orderCards'];
        return {};
      };
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
            const cardStates = new Map();
            const rows = [];
            const runtime = {
              legacyOrderStateApi: {
                getCardState: key => cardStates.get(key),
                setCardState: (key, state) => { cardStates.set(key, state); },
                clearCardState: key => { cardStates.delete(key); },
                setPendingExecLabel: () => {},
                getPendingExecLabel: () => null,
                clearPendingExecLabel: () => {},
                markPendingRequest: () => {},
                resolvePendingKey: () => null,
                setPendingId: () => {},
                getPendingId: () => null,
                getRetryCount: () => 0,
                findPendingRequestIdByKey: () => null,
                clearPendingRequest: () => {},
                clearPendingByKey: () => {},
                markPlacedOrder: () => {},
                getPlacedOrder: () => null,
                deletePlacedOrder: () => {},
                resolveTicketKey: () => null,
                bindTicket: () => {},
                unbindTicket: () => {},
                listPlacedOrders: () => [],
                clearExecutionStateByKey: () => {}
              },
              setClosedCardEventStrategy: () => {},
              renderLegacyCards(createCard) {
                for (const [index, row] of rows.entries()) createCard(row, index);
              },
              mount: () => {},
              markTouched: () => {},
              isTouched: () => false,
              removeRow: () => false,
              removeLegacyRowsForPosition: () => false,
              resetLegacyRowsForPosition: () => false,
              removeRowByKey: () => false,
              scheduleInstantExecution: () => {},
              migrateKey: key => key
            };
            context.registerTestingExtension?.('orderCardsRows', rows);
            context.registerTestingExtension?.('legacyOrderStateApi', runtime.legacyOrderStateApi);
            context.registerRendererRowProvider?.(() => rows);
            context.registerRendererLayer?.(({ grid } = {}) => {
              runtime.renderLegacyCards((row) => {
                const card = document.createElement('div');
                card.className = 'card';
                card.dataset.rowkey = context.rowKey(row);
                card.dataset.ticker = row.ticker;
                card.dataset.instrumentType = row.instrumentType || '';
                card.appendChild(document.createElement('input'));
                const status = document.createElement('span');
                status.className = 'card__status';
                card.appendChild(status);
                const spread = document.createElement('span');
                spread.className = 'card__spread';
                card.appendChild(spread);
                const buttons = document.createElement('div');
                buttons.className = 'btns';
                const button = document.createElement('button');
                button.className = 'btn';
                buttons.appendChild(button);
                card.appendChild(buttons);
                if (grid) grid.appendChild(card);
                return card;
              });
            });
          }
        }],
        rendererLegacyGuards: []
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button><div id="settings-restart-required"></div></div>`);
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

  const row = { ticker: 'TST', event: 'evt', time: 0, price: 1 };
  const key = t.rowKey(row);
  t.orderCardsRows.push(row);
  t.render();

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
