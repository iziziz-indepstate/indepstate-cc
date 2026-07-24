const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping orderCalculatorSettingsRenderer test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const calls = [];
  const descriptor = require('../app/services/orderCalculator/config/order-calculator-settings-descriptor.json');
  const ipcRenderer = {
    on() {},
    invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      if (channel === 'orders:list') return [];
      if (channel === 'settings:list') return [{ key: 'order-calculator', name: 'Order calculator' }];
      if (channel === 'settings:get' && args[0] === 'order-calculator') {
        return {
          config: {
            profitRate: 3,
            riskUsd: {
              byInstrumentType: { EQ: 50, FX: 50, CX: 0.2 },
              bySymbol: { OLD: 5 }
            }
          },
          descriptor
        };
      }
      if (channel === 'settings:set') return { saved: true };
      if (channel === 'settings:restart-status') return [];
      if (channel === 'actions-bus:list') return [];
      if (channel === 'actions-bus:set-enabled') return [];
      return {};
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer };
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button><div id="settings-restart-required"></div></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  require('../app/renderer.js');
  document.getElementById('settings-btn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));

  let rows = Array.from(document.querySelectorAll('.risk-symbol-row'));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].querySelector('input[data-role="symbol"]').value, 'OLD');
  assert.strictEqual(rows[0].querySelector('input[data-role="riskUsd"]').value, '5');
  rows[0].querySelector('button.settings-array-remove').click();

  const add = Array.from(document.querySelectorAll('button.settings-array-add'))
    .find(button => button.textContent === 'Add symbol override');
  assert(add);
  add.click();
  rows = Array.from(document.querySelectorAll('.risk-symbol-row'));
  rows[0].querySelector('input[data-role="symbol"]').value = 'NEW';
  rows[0].querySelector('input[data-role="riskUsd"]').value = '2.5';
  rows[0].querySelector('input[data-role="symbol"]')
    .dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  const jsonButton = Array.from(document.querySelectorAll('button[data-editor-mode="json"]'))
    .find(button => button.textContent === 'Symbol risks JSON');
  assert(jsonButton);
  jsonButton.click();
  const textarea = document.querySelector('textarea[data-role="raw-json"]');
  assert.deepStrictEqual(JSON.parse(textarea.value), { NEW: 2.5 });

  textarea.value = JSON.stringify({ FROMJSON: 4 });
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  document.querySelector('button[data-editor-mode="form"]').click();
  rows = Array.from(document.querySelectorAll('.risk-symbol-row'));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].querySelector('input[data-role="symbol"]').value, 'FROMJSON');
  assert.strictEqual(rows[0].querySelector('input[data-role="riskUsd"]').value, '4');

  rows[0].querySelector('button.settings-array-remove').click();
  const formAdd = Array.from(document.querySelectorAll('button.settings-array-add'))
    .find(button => button.textContent === 'Add symbol override');
  formAdd.click();
  formAdd.click();
  rows = Array.from(document.querySelectorAll('.risk-symbol-row'));
  rows[0].querySelector('input[data-role="symbol"]').value = 'FINAL';
  rows[0].querySelector('input[data-role="riskUsd"]').value = '6';
  rows[1].querySelector('input[data-role="symbol"]').value = 'INVALID';
  rows[1].querySelector('input[data-role="riskUsd"]').value = '-1';
  rows[0].querySelector('input[data-role="symbol"]')
    .dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  document.getElementById('settings-close').click();
  await new Promise(resolve => setTimeout(resolve, 0));

  const setCall = calls.find(call => call.channel === 'settings:set' && call.args[0] === 'order-calculator');
  assert(setCall);
  assert.deepStrictEqual(setCall.args[1], {
    profitRate: 3,
    riskUsd: {
      byInstrumentType: { EQ: 50, FX: 50, CX: 0.2 },
      bySymbol: { FINAL: 6 }
    }
  });

  Module._load = originalLoad;
  console.log('orderCalculatorSettingsRenderer tests passed');
}

run().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
