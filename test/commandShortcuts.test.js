const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping commandShortcuts test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const ran = [];
  const handlers = {};
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, ...args) => {
      if (ch === 'orders:list') return [];
      if (ch === 'settings:get' && args[0] === 'ui') return { autoscroll: true };
      if (ch === 'cmdline:shortcuts') return ['l'];
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'cmdline:run') { ran.push(args[0]); return { ok: true }; }
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

  require('../app/renderer.js');
  await new Promise(r => setImmediate(r));

  const cmd = document.getElementById('cmdline');

  // one-letter shortcuts are delayed so they do not steal longer typed commands
  const evt1 = new dom.window.KeyboardEvent('keydown', { key: 'l' });
  document.dispatchEvent(evt1);
  assert.deepStrictEqual(ran, []);
  assert.strictEqual(document.activeElement, cmd);
  assert.strictEqual(cmd.value, 'l');
  await new Promise(r => setTimeout(r, 300));
  assert.deepStrictEqual(ran, ['l']);
  assert.strictEqual(cmd.value, '');

  // typing a longer command starting with the shortcut cancels the delayed run
  ran.length = 0;
  cmd.blur();
  const evtLong = new dom.window.KeyboardEvent('keydown', { key: 'l' });
  document.dispatchEvent(evtLong);
  cmd.value = 'lo-ls';
  cmd.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  assert.deepStrictEqual(ran, []);

  // shortcut ignored when command line input is focused
  ran.length = 0;
  cmd.value = '';
  cmd.focus();
  const evt2 = new dom.window.KeyboardEvent('keydown', { key: 'l' });
  cmd.dispatchEvent(evt2);
  assert.deepStrictEqual(ran, []);
  console.log('commandShortcuts tests passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
