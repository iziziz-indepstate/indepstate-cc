const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping positionsRendererRenderFailureDiagnostics test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const previousDebugFlag = process.env.ISCC_DEBUG_POSITION_EVENTS;
  process.env.ISCC_DEBUG_POSITION_EVENTS = '1';

  const handlers = {};
  const logs = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => logs.push({ level: 'warn', text: args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ') });
  console.log = (...args) => logs.push({ level: 'log', text: args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ') });

  const initialPosition = {
    id: 'pos-good-1',
    state: 'draft',
    ticker: 'MSFT',
    symbol: 'MSFT',
    instrumentType: 'EQ',
    provider: 'simulated',
    version: 1,
    source: { cardType: 'regular', ticker: 'MSFT', event: 'manual', time: 1, price: 100, sl: 10 },
    card: {
      type: 'regular',
      actions: [{ id: 'BL', label: 'BL', command: 'position.open', style: 'bl' }],
      data: { ticker: 'MSFT', symbol: 'MSFT', provider: 'simulated', state: 'draft', price: 100, sl: 10 }
    }
  };
  const badPosition = {
    id: 'pos-bad-1',
    state: 'draft',
    ticker: 'BAD',
    symbol: 'BAD',
    instrumentType: 'EQ',
    provider: 'simulated',
    version: 2,
    source: { cardType: 'bad', ticker: 'BAD' },
    card: { type: 'bad', data: { ticker: 'BAD' }, actions: [] }
  };

  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, payload) => {
      if (ch === 'positions:list') return [initialPosition];
      if (ch === 'order-cards:list') return [];
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'settings:restart-status') return [];
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'instrument:get') return { quote: {}, metadata: { tickSize: 1 }, provider: payload.provider, symbol: payload.symbol };
      return {};
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer };
    return originalLoad(request, parent, isMain);
  };

  try {
    const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div><div id="settings-restart-required"></div>`);
    global.window = dom.window;
    global.document = dom.window.document;
    global.CSS = dom.window.CSS;
    global.navigator = { userAgent: 'node.js' };

    const renderer = require('../app/renderer.js');
    const t = renderer.__testing;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(document.querySelector('.position-card[data-position-id="pos-good-1"]'));

    t.positionCardRenderers.bad = () => {
      throw new Error('bad renderer boom');
    };
    handlers['positions:changed'](null, { event: { type: 'position.created' }, position: badPosition });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert(document.querySelector('.position-card[data-position-id="pos-good-1"]'));
    assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-bad-1"]'), null);
    assert(logs.some(entry => (
      entry.level === 'warn'
      && entry.text.includes('renderer.render:position-error')
      && entry.text.includes('pos-bad-1')
      && entry.text.includes('bad renderer boom')
    )));
  } finally {
    Module._load = originalLoad;
    console.warn = originalWarn;
    console.log = originalLog;
    if (previousDebugFlag === undefined) delete process.env.ISCC_DEBUG_POSITION_EVENTS;
    else process.env.ISCC_DEBUG_POSITION_EVENTS = previousDebugFlag;
  }

  console.log('positionsRendererRenderFailureDiagnostics tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
