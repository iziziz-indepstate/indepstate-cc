const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping rendererBootDiagnostics test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const previousDebugFlag = process.env.ISCC_DEBUG_POSITION_EVENTS;
  process.env.ISCC_DEBUG_POSITION_EVENTS = '1';

  const sent = [];
  const handlers = {};
  const originalLog = console.log;
  console.log = () => {};

  const ipcRenderer = {
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, payload) => {
      if (ch === 'positions:list') return [];
      if (ch === 'order-cards:list') return [];
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'settings:restart-status') return [];
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'cmdline:shortcuts') return [];
      if (ch === 'instrument:get') return { quote: {}, metadata: { tickSize: 1 }, provider: payload.provider, symbol: payload.symbol };
      return {};
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer };
    return originalLoad(request, parent, isMain);
  };

  const rendererPath = require.resolve('../app/renderer.js');
  const debugPath = require.resolve('../app/debugPositionEvents');
  delete require.cache[rendererPath];
  delete require.cache[debugPath];

  try {
    const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div><div id="settings-restart-required"></div>`);
    global.window = dom.window;
    global.document = dom.window.document;
    global.CSS = dom.window.CSS;
    global.navigator = { userAgent: 'node.js' };

    require('../app/renderer.js');
    await new Promise(resolve => setImmediate(resolve));

    const scopes = sent
      .filter(item => item.channel === 'debug:position-events')
      .map(item => item.payload.scope);
    assert(scopes.includes('renderer.boot:start'));
    assert(scopes.includes('renderer.boot:after-hooks'));
    assert(scopes.includes('renderer.boot:after-handler-load'));
    assert.strictEqual(scopes.includes('renderer.boot:after-legacy-runtime-check'), false);
    assert(scopes.includes('renderer.boot:before-positions-mount'));
    assert(scopes.includes('renderer.boot:after-positions-mount'));
    assert(scopes.includes('renderer.boot:ready'));
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    delete require.cache[rendererPath];
    delete require.cache[debugPath];
    delete global.window;
    delete global.document;
    delete global.CSS;
    delete global.navigator;
    if (previousDebugFlag === undefined) delete process.env.ISCC_DEBUG_POSITION_EVENTS;
    else process.env.ISCC_DEBUG_POSITION_EVENTS = previousDebugFlag;
  }

  console.log('rendererBootDiagnostics tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
