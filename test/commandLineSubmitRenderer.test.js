const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping commandLineSubmitRenderer test');
  process.exit(0);
}
const Module = require('module');

async function runScenario(response) {
  const calls = [];
  const toasts = [];
  const handlers = {};
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, ...args) => {
      if (ch === 'cmdline:run') {
        calls.push({ ch, args });
        if (response instanceof Error) throw response;
        return response;
      }
      if (ch === 'order-cards:list') return [];
      if (ch === 'settings:get' && args[0] === 'ui') return { autoscroll: true };
      if (ch === 'cmdline:shortcuts') return ['l'];
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
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

  const rendererPath = require.resolve('../app/renderer.js');
  delete require.cache[rendererPath];
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, '/').endsWith('/app/services/commandLine/manifest.js')) {
      delete require.cache[key];
    }
  }

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  try {
    require('../app/renderer.js');
    await new Promise(r => setImmediate(r));
    window.toast = (msg) => toasts.push(msg);

    const cmdline = document.getElementById('cmdline');
    cmdline.value = 'a ADAUSDT.cfd 0.1981';
    cmdline.focus();
    cmdline.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true
    }));
    await new Promise(r => setImmediate(r));

    return { calls, toasts, value: cmdline.value };
  } finally {
    Module._load = originalLoad;
    delete require.cache[rendererPath];
    delete global.window;
    delete global.document;
    delete global.CSS;
    delete global.navigator;
  }
}

async function run() {
  {
    const result = await runScenario({ ok: true });
    assert.deepStrictEqual(result.calls, [{
      ch: 'cmdline:run',
      args: ['a ADAUSDT.cfd 0.1981']
    }]);
    assert.strictEqual(result.value, '');
    assert.deepStrictEqual(result.toasts, []);
  }

  {
    const result = await runScenario({ ok: false, error: 'boom' });
    assert.deepStrictEqual(result.calls, [{
      ch: 'cmdline:run',
      args: ['a ADAUSDT.cfd 0.1981']
    }]);
    assert.strictEqual(result.value, 'a ADAUSDT.cfd 0.1981');
    assert.deepStrictEqual(result.toasts, ['boom']);
  }

  {
    const result = await runScenario(new Error('reject boom'));
    assert.deepStrictEqual(result.calls, [{
      ch: 'cmdline:run',
      args: ['a ADAUSDT.cfd 0.1981']
    }]);
    assert.strictEqual(result.value, 'a ADAUSDT.cfd 0.1981');
    assert.deepStrictEqual(result.toasts, ['reject boom']);
  }

  console.log('commandLine submit renderer tests passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
