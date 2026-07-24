const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (error) {
  console.log('jsdom not installed, skipping actionsBusSettingsRenderer test');
  process.exit(0);
}
const Module = require('module');

const flush = () => new Promise(resolve => setImmediate(resolve));

async function run() {
  const calls = [];
  const handlers = {};
  const descriptor = require('../app/services/actions-bus/config/actions-bus-settings-descriptor.json');
  const initialConfig = {
    enabled: true,
    actions: [{ event: 'order:placed', action: 'commandLine:old {id}', name: 'Old action' }]
  };
  const ipcRenderer = {
    on: (channel, handler) => { handlers[channel] = handler; },
    invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      if (channel === 'orders:list') return [];
      if (channel === 'settings:list') return [{ key: 'actions-bus', name: 'Actions bus', group: 'automation' }];
      if (channel === 'settings:get' && args[0] === 'actions-bus') {
        return { config: initialConfig, descriptor };
      }
      if (channel === 'settings:set') {
        return {
          saved: true,
          section: args[0],
          config: args[1],
          appliedPaths: ['actions'],
          restartRequiredPaths: [],
          errors: []
        };
      }
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

  const dom = new JSDOM(`<!DOCTYPE html>
    <div id="wrap"><div id="grid"></div></div>
    <input id="filter"><input id="cmdline"><button id="settings-btn"></button>
    <div id="settings-panel"><div id="settings-restart-required"></div><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  try {
    require('../app/renderer.js');
    document.getElementById('settings-btn').click();
    await flush();
    await flush();

    const form = document.querySelector('form[data-section="actions-bus"]');
    const formButton = form.querySelector('button[data-editor-mode="form"]');
    const jsonButton = form.querySelector('button[data-editor-mode="json"]');
    const textarea = form.querySelector('textarea[data-role="raw-json"]');
    const error = form.querySelector('[data-role="raw-json-error"]');
    assert(form && formButton && jsonButton && textarea && error);
    assert.strictEqual(form.dataset.editorMode, 'form');
    assert(formButton.classList.contains('active'));
    assert.strictEqual(jsonButton.textContent, 'Actions JSON');

    jsonButton.click();
    assert.deepStrictEqual(JSON.parse(textarea.value), initialConfig.actions);
    formButton.click();

    const actionInput = form.querySelector('input[data-field="actions.0.action"]');
    actionInput.value = 'commandLine:changed {id}';
    actionInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    jsonButton.click();
    assert.strictEqual(form.dataset.editorMode, 'json');
    assert.strictEqual(JSON.parse(textarea.value)[0].action, 'commandLine:changed {id}');
    assert.strictEqual(form.dataset.dirty, '1');

    const pastedActions = [{
        name: 'TradingView automation',
        label: 'TV auto-lines',
        bindings: [{ event: 'tv-tool-horzline', action: 'commandLine:lo {symbol} {price}' }]
    }];
    textarea.value = JSON.stringify(pastedActions);
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    formButton.click();
    assert.strictEqual(form.dataset.editorMode, 'form');
    assert.strictEqual(form.querySelector('input[data-field="actions.0.name"]').value, 'TradingView automation');
    assert.strictEqual(form.querySelector('input[data-field="actions.0.bindings.0.event"]').value, 'tv-tool-horzline');

    const enabledInput = form.querySelector('input[data-field="enabled"]');
    enabledInput.checked = false;
    enabledInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    jsonButton.click();
    textarea.value = JSON.stringify(pastedActions);
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    const snippetToggle = form.querySelector('button.settings-snippet-toggle');
    const snippetEditor = form.querySelector('textarea[data-role="raw-json-snippet"]');
    const appendSnippet = Array.from(form.querySelectorAll('.settings-snippet-actions button'))
      .find(button => button.textContent === 'Append');
    const snippetError = form.querySelector('[data-role="raw-json-snippet-error"]');
    assert(snippetToggle && snippetEditor && appendSnippet && snippetError);
    snippetToggle.click();
    snippetEditor.value = '42';
    appendSnippet.click();
    assert.notStrictEqual(snippetError.style.display, 'none');
    assert.deepStrictEqual(JSON.parse(textarea.value), pastedActions);

    const singleSnippet = { event: 'position:opened', action: 'commandLine:notify opened {id}' };
    snippetEditor.value = JSON.stringify(singleSnippet);
    appendSnippet.click();
    assert.deepStrictEqual(JSON.parse(textarea.value), [...pastedActions, singleSnippet]);

    const arraySnippet = [{ event: 'position:closed', action: 'commandLine:notify closed {id}' }];
    snippetToggle.click();
    snippetEditor.value = JSON.stringify(arraySnippet);
    appendSnippet.click();
    const expectedActions = [...pastedActions, singleSnippet, ...arraySnippet];
    assert.deepStrictEqual(JSON.parse(textarea.value), expectedActions);

    textarea.value = '{';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    formButton.click();
    assert.strictEqual(form.dataset.editorMode, 'json');
    assert.notStrictEqual(error.style.display, 'none');
    document.getElementById('settings-close').click();
    await flush();
    assert.strictEqual(calls.filter(call => call.channel === 'settings:set').length, 0);
    assert.strictEqual(document.getElementById('settings-panel').style.display, 'flex');

    textarea.value = '{}';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    document.getElementById('settings-close').click();
    await flush();
    assert.strictEqual(calls.filter(call => call.channel === 'settings:set').length, 0);
    assert.match(error.textContent, /JSON array/);

    textarea.value = JSON.stringify(expectedActions, null, 2);
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    document.getElementById('settings-close').click();
    await flush();
    await flush();

    const setCalls = calls.filter(call => call.channel === 'settings:set');
    assert.strictEqual(setCalls.length, 1);
    assert.strictEqual(setCalls[0].args[0], 'actions-bus');
    assert.deepStrictEqual(setCalls[0].args[1], { enabled: false, actions: expectedActions });
    assert.strictEqual(document.getElementById('settings-panel').style.display, 'none');
  } finally {
    Module._load = originalLoad;
  }

  console.log('actionsBusSettingsRenderer tests passed');
}

run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
