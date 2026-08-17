const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping rendererBootOrderCardsOptional test');
  process.exit(0);
}
const Module = require('module');

function setupDom() {
  const dom = new JSDOM(`<!DOCTYPE html>
    <div id="wrap"><div id="grid"></div></div>
    <input id="filter"><input id="cmdline">
    <button id="settings-btn"></button>
    <div id="settings-panel">
      <div id="settings-sections"></div>
      <div id="settings-fields"></div>
      <button id="settings-close"></button>
      <div id="settings-restart-required"></div>
    </div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };
}

function cleanupDom() {
  delete global.window;
  delete global.document;
  delete global.CSS;
  delete global.navigator;
}

function createRuntime({ onMount } = {}) {
  return {
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
    setClosedCardEventStrategy: () => {},
    renderLegacyCards: () => {},
    mount: () => onMount?.(),
    markTouched: () => {},
    isTouched: () => false,
    removeRow: () => false,
    removeLegacyRowsForPosition: () => false,
    resetLegacyRowsForPosition: () => false,
    removeRowByKey: () => false,
    scheduleInstantExecution: () => undefined,
    setFilter: () => {},
    migrateKey: key => key
  };
}

function position(id, cardType) {
  return {
    id,
    state: 'draft',
    ticker: `${cardType.toUpperCase()}1`,
    symbol: `${cardType.toUpperCase()}1`,
    provider: 'simulated',
    instrumentType: cardType === 'option' ? 'OPT' : 'EQ',
    version: 1,
    card: {
      type: cardType,
      actions: [],
      data: {
        ticker: `${cardType.toUpperCase()}1`,
        state: 'draft',
        price: 10,
        qty: 1,
        provider: 'simulated'
      }
    }
  };
}

async function loadRenderer({ services, includeOrderCards = false } = {}) {
  const handlers = {};
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    send: () => {},
    invoke: async (ch) => {
      if (ch === 'positions:list') return [];
      if (ch === 'order-cards:list') return [];
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'settings:restart-status') return [];
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'cmdline:shortcuts') return [];
      return {};
    }
  };
  let mountCalls = 0;
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const parentPath = String(parent?.filename || '').replace(/\\/g, '/');
    const normalizedRequest = String(request).replace(/\\/g, '/');
    if (request === 'electron') return { ipcRenderer };
    if (parentPath.endsWith('app/renderer.js') && request === './config/load') {
      const loadConfig = (name) => {
        if (name === '../services/settings/config/services.json') return services;
        return {};
      };
      loadConfig.CONFIG_ROOTS = [];
      loadConfig.APP_ROOT = '';
      loadConfig.USER_ROOT = '';
      return loadConfig;
    }
    if (normalizedRequest.endsWith('/app/services/orderCards/manifest.js') && includeOrderCards) {
      return {
        rendererHandlers: [{
          register(context = {}) {
            const runtime = createRuntime({ onMount: () => { mountCalls += 1; } });
            context.registerRendererLayer?.(({ grid } = {}) => {
              const row = { ticker: 'LEGACY', event: 'legacy', time: 1, price: 1, cardType: 'legacyExtension' };
              const card = document.createElement('div');
              card.className = 'card';
              card.dataset.rowkey = context.rowKey(row);
              if (grid) grid.appendChild(card);
            });
            context.registerTestingExtension?.('legacyOrderStateApi', runtime.legacyOrderStateApi);
            runtime.mount();
            context.createLegacyOrderCard = (row) => {
                const card = document.createElement('div');
                card.className = 'card';
                card.dataset.rowkey = context.rowKey(row);
                return card;
            };
          }
        }]
      };
    }
    if (normalizedRequest.endsWith('/app/services/levelOrder/manifest.js')) {
      return {
        rendererPositionHandlers: [{
          cardType: 'levelOrder',
          register(context = {}) {
            const runtime = context.cardRuntime;
            runtime.registerCardView('level-order-test-view', () => context.el('div', 'level-order-test-card', 'levelOrder'));
            runtime.registerCardControl('level-order-test-control', () => ({}));
            runtime.registerCardShape('level-order-test-shape', ({ position, key, body }) => {
              const card = context.el('div', 'card position-card');
              card.dataset.rowkey = key;
              card.dataset.positionId = position.id;
              card.dataset.cardType = 'levelOrder';
              card.appendChild(body);
              return card;
            });
            runtime.registerCardType({
              type: 'levelOrder',
              view: 'level-order-test-view',
              controls: ['level-order-test-control'],
              shape: 'level-order-test-shape'
            });
          }
        }]
      };
    }
    if (normalizedRequest.endsWith('/app/services/optionstrat/manifest.js')) {
      return {
        rendererHandlers: [{
          cardType: 'option',
          register(context = {}) {
            const runtime = context.cardRuntime;
            runtime.registerCardView('option-test-view', () => context.el('div', 'option-test-card', 'option'));
            runtime.registerCardControl('option-test-control', () => ({}));
            runtime.registerCardShape('option-test-shape', ({ position, key, body }) => {
              const card = context.el('div', 'card position-card');
              card.dataset.rowkey = key;
              card.dataset.positionId = position.id;
              card.dataset.cardType = 'option';
              card.appendChild(body);
              return card;
            });
            runtime.registerCardType({
              type: 'option',
              view: 'option-test-view',
              controls: ['option-test-control'],
              shape: 'option-test-shape'
            });
          }
        }]
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const rendererPath = require.resolve('../app/renderer.js');
  delete require.cache[rendererPath];
  setupDom();
  try {
    const renderer = require('../app/renderer.js');
    await new Promise(resolve => setImmediate(resolve));
    return { renderer, handlers, restore: () => {
      Module._load = originalLoad;
      delete require.cache[rendererPath];
      cleanupDom();
    }, mountCalls: () => mountCalls };
  } catch (err) {
    Module._load = originalLoad;
    delete require.cache[rendererPath];
    cleanupDom();
    throw err;
  }
}

async function run() {
  {
    const ctx = await loadRenderer({
      services: ['services/levelOrder', 'services/optionstrat']
    });
    try {
      assert.strictEqual(typeof ctx.renderer.__testing.render, 'function');
      assert.strictEqual(ctx.mountCalls(), 0);
      assert.strictEqual(typeof ctx.handlers['positions:changed'], 'function');
      ctx.handlers['positions:changed'](null, { event: { type: 'position.created' }, position: position('regular-1', 'regular') });
      ctx.handlers['positions:changed'](null, { event: { type: 'position.created' }, position: position('level-1', 'levelOrder') });
      ctx.handlers['positions:changed'](null, { event: { type: 'position.created' }, position: position('option-1', 'option') });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(document.querySelector('.position-card[data-position-id="regular-1"]'), null);
      assert(document.querySelector('.position-card[data-position-id="level-1"][data-card-type="levelOrder"] .level-order-test-card'));
      assert(document.querySelector('.position-card[data-position-id="option-1"][data-card-type="option"] .option-test-card'));
      assert.strictEqual(document.querySelectorAll('.card:not(.position-card)').length, 0);
    } finally {
      ctx.restore();
    }
  }

  {
    const ctx = await loadRenderer({
      services: ['services/orderCards'],
      includeOrderCards: true
    });
    try {
      assert.strictEqual(ctx.mountCalls(), 1);
      assert.strictEqual(typeof ctx.renderer.__testing.legacyOrderStateApi.getCardState, 'function');
    } finally {
      ctx.restore();
    }
  }

  console.log('rendererBootOrderCardsOptional tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
