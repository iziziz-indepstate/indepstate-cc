const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const settings = require('../settings');
const { createCommandService } = require('.');

settings.register(
  'command-line',
  path.join(__dirname, 'config', 'command-line.json'),
  path.join(__dirname, 'config', 'command-line-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  const cmdService = createCommandService({
    commands: servicesApi.commands,
    executionApi: servicesApi,
    onAdd(row) {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('orders:new', row);
      }
    },
    onRemove(filter) {
      const win = BrowserWindow.getAllWindows()[0];
      if (!filter || typeof filter !== 'object') return { ok: false, error: 'Invalid remove payload' };
      if (win && !win.isDestroyed()) {
        win.webContents.send('orders:remove', filter);
        return { ok: true };
      }
      return { ok: false, error: 'No window' };
    }
  });
  servicesApi.commandLine = cmdService;
  if (servicesApi.actionBus) {
    const runner = (cmd) => cmdService.run(cmd);
    if (typeof servicesApi.actionBus.registerCommandRunner === 'function') {
      servicesApi.actionBus.registerCommandRunner('commandLine', runner);
    }
    if (typeof servicesApi.actionBus.setCommandRunner === 'function') {
      servicesApi.actionBus.setCommandRunner(runner);
    }
  }
  ipcMain.handle('cmdline:run', (_evt, str) => cmdService.run(str));
  ipcMain.handle('cmdline:shortcuts', () => {
    const { config } = settings.readConfig('command-line') || {};
    const list = config && config.shortcuts;
    return Array.isArray(list) ? list.map(String) : [];
  });
}

function hookRenderer(ipcRenderer) {
  let shortcuts = new Set();
  ipcRenderer
    .invoke('cmdline:shortcuts')
    .then((list = []) => {
      if (Array.isArray(list)) shortcuts = new Set(list.map(String));
    })
    .catch(() => {});

  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isInput = active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.isContentEditable
    );
    if (!isInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const cmdline = document.getElementById('cmdline');
      if (shortcuts.has(e.key)) {
        ipcRenderer.invoke('cmdline:run', e.key)
          .then((res) => {
            if (!res?.ok && res?.error) window.toast?.(res.error);
          })
          .catch((err) => {
            window.toast?.(err.message || String(err));
          });
        if (cmdline) cmdline.value = '';
        e.preventDefault();
      } else {
        cmdline?.focus();
        if (e.key.length === 1) {
          if (cmdline) cmdline.value += e.key;
          e.preventDefault();
        } else if (e.key === 'Backspace') {
          if (cmdline) cmdline.value = cmdline.value.slice(0, -1);
          e.preventDefault();
        }
      }
    }
  });
}

module.exports = { initService, hookRenderer };
