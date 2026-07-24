const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping tickSizesSettingsRenderer test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const handlers = {};
  const calls = [];
  const descriptor = require('../app/services/instrumentInfo/config/tick-sizes-settings-descriptor.json');
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, ...args) => {
      calls.push({ ch, args });
      if (ch === 'orders:list') return [];
      if (ch === 'settings:list') return [{ key: 'tick-sizes', name: 'Tick sizes' }];
      if (ch === 'settings:get') {
        if (args[0] === 'tick-sizes') {
          return {
            config: {
              bySymbol: { OLDUSDT_P: 0.01 },
              patterns: []
            },
            descriptor
          };
        }
        return {};
      }
      if (ch === 'settings:set') return true;
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      return {};
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer };
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  require('../app/renderer.js');
  document.getElementById('settings-btn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));

  let rows = Array.from(document.querySelectorAll('.tick-size-symbol-row'));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].querySelector('input[data-role="symbol"]').value, 'OLDUSDT_P');
  rows[0].querySelector('button.settings-array-remove').click();

  const add = Array.from(document.querySelectorAll('button.settings-array-add'))
    .find(btn => btn.textContent === 'Add symbol override');
  assert(add);
  add.click();
  rows = Array.from(document.querySelectorAll('.tick-size-symbol-row'));
  assert.strictEqual(rows.length, 1);
  rows[0].querySelector('input[data-role="symbol"]').value = 'NEWUSDT.P';
  rows[0].querySelector('input[data-role="tickSize"]').value = '0.001';
  rows[0].querySelector('input[data-role="symbol"]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  document.getElementById('settings-close').click();
  await new Promise(resolve => setTimeout(resolve, 0));

  const setCall = calls.find(c => c.ch === 'settings:set' && c.args[0] === 'tick-sizes');
  assert(setCall);
  assert.deepStrictEqual(setCall.args[1].bySymbol, { 'NEWUSDT.P': 0.001 });
  assert.deepStrictEqual(setCall.args[1].patterns, []);

  Module._load = originalLoad;
  console.log('tickSizesSettingsRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
