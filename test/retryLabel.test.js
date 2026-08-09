const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping retryLabel test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const handlers = {};
  const invokes = [];
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, ...args) => {
      invokes.push({ ch, args });
      if (ch === 'orders:list') return [];
      if (ch === 'settings:get') return { autoscroll: true };
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      return {};
    }
  };

  // stub electron before requiring renderer
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') {
      return { ipcRenderer };
    }
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  const renderer = require('../app/renderer.js');
  const t = renderer.__testing;

  const row = { cardType: 'legacyExtension', ticker: 'TST', event: 'evt', time: 0, price: 1 };
  handlers['orders:new'](null, row);
  const key = t.rowKey(row);
  t.setCardState(key, 'pending-exec');

  handlers['execution:pending'](null, { reqId: 'r1', pendingId: 'p1', order: { symbol: 'TST', side: 'buy' } });

  assert.strictEqual(t.legacyOrderStateApi.getCardState(key), 'pending');
  const card = t.cardByKey(key);
  const retryBtn = card.querySelector('.retry-btn');
  assert.ok(retryBtn);
  assert.strictEqual(retryBtn.style.display, 'inline-block');
  assert.strictEqual(retryBtn.textContent, '0');

  handlers['execution:retry'](null, { reqId: 'r1', count: 2 });
  assert.strictEqual(retryBtn.textContent, '2');

  retryBtn.click();
  assert.ok(invokes.find(i => i.ch === 'execution:stop-retry' && i.args[0] === 'r1'));

  console.log('retryLabel test passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
