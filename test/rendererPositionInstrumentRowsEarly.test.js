const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping rendererPositionInstrumentRowsEarly test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const handlers = {};
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch) => {
      if (ch === 'positions:list') return [];
      if (ch === 'order-cards:list') return [];
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:restart-status') return [];
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'cmdline:shortcuts') return [];
      return {};
    }
  };

  let rowsDuringInstrumentInfoCreate = null;
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
        createInstrumentInfoRenderer(deps) {
          rowsDuringInstrumentInfoCreate = deps.getRows();
          return {
            instrumentInfo: new Map(),
            instrumentInfoFor: () => null,
            ensureInstrument: () => {},
            forgetInstrument: () => {},
            tickSize: () => 0.01,
            formatBidAskText: () => '',
            formatSpreadTriple: () => '',
            updateSpreadForTicker: () => {},
            revalidateCardsForTicker: () => {},
            startPeriodicRefresh: () => {},
            trackInstrument: () => {},
            untrackInstrument: () => {}
          };
        }
      };
    }
    if (normalizedRequest.endsWith('/app/services/orderCards/manifest.js')) {
      return { rendererHandlers: [] };
    }
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button><div id="settings-restart-required"></div></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  const rendererPath = require.resolve('../app/renderer.js');
  delete require.cache[rendererPath];
  try {
    require('../app/renderer.js');
    assert.deepStrictEqual(rowsDuringInstrumentInfoCreate, []);
  } finally {
    Module._load = originalLoad;
    delete require.cache[rendererPath];
    delete global.window;
    delete global.document;
    delete global.CSS;
    delete global.navigator;
  }

  console.log('rendererPositionInstrumentRowsEarly tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
