const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping rendererManifestLoadDiagnostics test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const previousDebugFlag = process.env.ISCC_DEBUG_POSITION_EVENTS;
  process.env.ISCC_DEBUG_POSITION_EVENTS = '1';

  const sent = [];
  const ipcRenderer = {
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    on: () => {},
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
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};
  Module._load = function(request, parent, isMain) {
    const parentPath = String(parent?.filename || '').replace(/\\/g, '/');
    const normalizedRequest = String(request).replace(/\\/g, '/');
    if (request === 'electron') return { ipcRenderer };
    if (parentPath.endsWith('app/renderer.js') && request === './config/load') {
      const fakeLoad = (name) => {
        if (name === '../services/settings/config/services.json') return ['services/bad', 'services/orderCards'];
        return {};
      };
      fakeLoad.CONFIG_ROOTS = ['config-a', 'config-b'];
      fakeLoad.APP_ROOT = 'app-root';
      fakeLoad.USER_ROOT = 'user-root';
      return fakeLoad;
    }
    if (normalizedRequest.endsWith('/app/services/bad/manifest.js')) {
      throw new Error('bad manifest boom');
    }
    if (normalizedRequest.endsWith('/app/services/orderCards/manifest.js')) {
      return {
        rendererHandlers: [{
          cardType: 'regular',
          register(context = {}) {
            context.registerRendererLayer?.(() => {});
          }
        }]
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
  const debugPath = require.resolve('../app/debugPositionEvents');
  delete require.cache[rendererPath];
  delete require.cache[debugPath];
  try {
    require('../app/renderer.js');
    const serviceList = sent.find(item => item.payload?.scope === 'renderer.manifest:service-list')?.payload?.details;
    assert.deepStrictEqual(serviceList.configRoots, ['config-a', 'config-b']);
    assert.deepStrictEqual(serviceList.dirs, ['services/bad', 'services/orderCards']);

    const failed = sent.find(item => item.payload?.scope === 'renderer.manifest:load-failed')?.payload?.details;
    assert.strictEqual(failed.dir, 'services/bad');
    assert.strictEqual(failed.error, 'bad manifest boom');
    assert(String(failed.stack || '').includes('bad manifest boom'));
  } finally {
    Module._load = originalLoad;
    console.error = originalError;
    console.log = originalLog;
    console.warn = originalWarn;
    delete require.cache[rendererPath];
    delete require.cache[debugPath];
    delete global.window;
    delete global.document;
    delete global.CSS;
    delete global.navigator;
    if (previousDebugFlag === undefined) delete process.env.ISCC_DEBUG_POSITION_EVENTS;
    else process.env.ISCC_DEBUG_POSITION_EVENTS = previousDebugFlag;
  }

  console.log('rendererManifestLoadDiagnostics tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
