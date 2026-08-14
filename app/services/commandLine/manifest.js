const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const settings = require('../settings');
const { createCommandService } = require('.');

settings.register(
  'command-line',
  path.join(__dirname, 'config', 'command-line.json'),
  path.join(__dirname, 'config', 'command-line-settings-descriptor.json')
);

function isMainAppWindow(win) {
  if (!win || win.isDestroyed?.()) return false;
  const url = String(win.webContents?.getURL?.() || '');
  return /(?:^|\/|\\)index\.html(?:$|[?#])/i.test(url);
}

function getOrderWindows() {
  const windows = (BrowserWindow.getAllWindows?.() || []).filter(win => win && !win.isDestroyed?.());
  return windows.filter(isMainAppWindow);
}

function sendToOrderWindows(channel, payload) {
  let sent = 0;
  for (const win of getOrderWindows()) {
    win.webContents?.send?.(channel, payload);
    sent += 1;
  }
  return sent;
}

function initService(servicesApi = {}) {
  const { config } = settings.readConfig('command-line') || {};
  const cmdService = createCommandService({
    commands: servicesApi.commands,
    executionApi: servicesApi,
    aliases: config && config.aliases,
    onAdd(row) {
      sendToOrderWindows('orders:new', row);
    },
    onRemove(filter) {
      if (!filter || typeof filter !== 'object') return { ok: false, error: 'Invalid remove payload' };
      if (sendToOrderWindows('orders:remove', filter) > 0) return { ok: true };
      return { ok: false, error: 'No window' };
    }
  });
  servicesApi.commandLine = cmdService;
  settings.onApply('command-line', ({ config }) => cmdService.configure({ aliases: config?.aliases }));
  if (servicesApi.actionBus) {
    const runner = (cmd) => cmdService.run(cmd);
    if (typeof servicesApi.actionBus.registerCommandRunner === 'function') {
      servicesApi.actionBus.registerCommandRunner('commandLine', runner);
    }
    if (typeof servicesApi.actionBus.setCommandRunner === 'function') {
      servicesApi.actionBus.setCommandRunner(runner);
    }
  }
  ipcMain.handle('cmdline:run', (evt, str) => cmdService.run(str, { sender: evt?.sender }));
  ipcMain.handle('cmdline:shortcuts', () => {
    const { config } = settings.readConfig('command-line') || {};
    const list = config && config.shortcuts;
    return Array.isArray(list) ? list.map(String) : [];
  });
}

function hookRenderer(ipcRenderer) {
  let shortcuts = new Set();
  let pendingShortcutTimer = null;
  const shortcutDelayMs = 250;

  function clearPendingShortcut() {
    if (pendingShortcutTimer) {
      clearTimeout(pendingShortcutTimer);
      pendingShortcutTimer = null;
    }
  }

  function runShortcut(cmd, cmdline) {
    clearPendingShortcut();
    ipcRenderer.invoke('cmdline:run', cmd)
      .then((res) => {
        if (!res?.ok && res?.error) window.toast?.(res.error);
        if (cmdline && cmdline.value.trim() === cmd) cmdline.value = '';
      })
      .catch((err) => {
        window.toast?.(err.message || String(err));
      });
  }

  ipcRenderer
    .invoke('cmdline:shortcuts')
    .then((list = []) => {
      if (Array.isArray(list)) shortcuts = new Set(list.map(String));
    })
    .catch(() => {});

  ipcRenderer.on('settings:changed', (_event, result) => {
    if (result?.section !== 'command-line') return;
    const list = result.config?.shortcuts;
    shortcuts = new Set(Array.isArray(list) ? list.map(String) : []);
  });

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
        if (cmdline && e.key.length === 1) {
          clearPendingShortcut();
          cmdline.focus();
          cmdline.value = e.key;
          pendingShortcutTimer = setTimeout(() => {
            pendingShortcutTimer = null;
            if (document.activeElement === cmdline && cmdline.value.trim() === e.key) {
              runShortcut(e.key, cmdline);
            }
          }, shortcutDelayMs);
        } else {
          runShortcut(e.key, cmdline);
        }
        e.preventDefault();
      } else {
        clearPendingShortcut();
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

  document.addEventListener('input', (e) => {
    const target = e.target;
    if (target && target.id === 'cmdline') clearPendingShortcut();
  });
}

module.exports = { initService, hookRenderer, isMainAppWindow, getOrderWindows };
