const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping rendererOrderCardsManifestLoad test');
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

  const originalLoad = Module._load;
  const originalError = console.error;
  console.error = () => {};
  Module._load = function(request, parent, isMain) {
    const parentPath = String(parent?.filename || '').replace(/\\/g, '/');
    if (request === 'electron') return { ipcRenderer };
    if (parentPath.endsWith('app/renderer.js') && request === './config/load') {
      return (name) => {
        if (name === '../services/settings/config/services.json') return ['services/orderCards'];
        if (name === '../services/orderCards/config/order-cards.json') return {};
        return {};
      };
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
    const renderer = require('../app/renderer.js');
    const t = renderer.__testing;
    assert.strictEqual(typeof t.migrateKey, 'function');
    const regular = t.cardRuntime.resolveCardType({ card: { type: 'regular' } }, { kind: 'position' });
    assert(regular);
    assert.strictEqual(regular.shape, 'regular-position-card');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(t, 'orderCardTypeHandlers'), false);
  } finally {
    Module._load = originalLoad;
    console.error = originalError;
    delete require.cache[rendererPath];
    delete global.window;
    delete global.document;
    delete global.CSS;
    delete global.navigator;
  }

  console.log('rendererOrderCardsManifestLoad tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
