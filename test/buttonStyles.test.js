const assert = require('assert');
const fs = require('fs');
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping buttonStyles test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  const placedColor = indexHtml.match(/\.card__status--placed\s*\{\s*background:([^;]+);/)?.[1];
  const executingColor = indexHtml.match(/\.card__status--executing\s*\{\s*background:([^;]+);/)?.[1];
  assert.strictEqual(placedColor, '#3b82f6');
  assert.strictEqual(executingColor, '#f59e0b');
  assert.notStrictEqual(placedColor, executingColor);

  const handlers = {};
  const rendererFailures = [];
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, ...args) => {
      if (ch === 'orders:list') return [];
      if (ch === 'settings:get') return { autoscroll: true };
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'settings:renderer-failed') { rendererFailures.push(args); return {}; }
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      return {};
    }
  };

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
  await new Promise(resolve => setImmediate(resolve));

  const row = { ticker: 'TST', event: 'evt', time: 0, price: 1 };
  handlers['orders:new'](null, row);
  const card = t.cardByKey(t.rowKey(row));
  const buttons = card.querySelectorAll('button.btn');
  const bfbBtn = Array.from(buttons).find(b => b.dataset.kind === 'BFB');
  const sfbBtn = Array.from(buttons).find(b => b.dataset.kind === 'SFB');
  assert(bfbBtn.classList.contains('bc'));
  assert(sfbBtn.classList.contains('sc'));
  await handlers['settings:changed'](null, {
    saved: true,
    section: 'order-cards',
    config: { ...require('../app/services/orderCards/config/order-cards.json'), buttons: [{ label: 'LIVE', action: 'BL', style: 'bl' }] },
    appliedPaths: ['buttons']
  });
  assert.deepStrictEqual(rendererFailures, []);
  assert.strictEqual(t.state.rows.length, 1);
  assert.strictEqual(document.querySelectorAll('.card').length, 1);
  assert.deepStrictEqual(
    Array.from(document.querySelectorAll('.card button.btn')).map(button => button.textContent),
    ['LIVE']
  );
  console.log('buttonStyles test passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
