const fs = require('fs');
const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createActionsBus } = require('.');

let ipcMain;
try {
  ({ ipcMain } = require('electron'));
} catch {
  ipcMain = null;
}

settings.register(
  'actions-bus',
  path.join(__dirname, 'config', 'actions-bus.json'),
  path.join(__dirname, 'config', 'actions-bus-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/actions-bus/config/actions-bus.json');
  } catch {
    cfg = {};
  }

  let stateFile = null;
  const savedStates = Object.create(null);
  try {
    const electronApp = require('electron')?.app;
    if (electronApp && typeof electronApp.getPath === 'function') {
      stateFile = path.join(electronApp.getPath('userData'), 'actions-bus-state.json');
      if (fs.existsSync(stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [name, enabledState] of Object.entries(parsed)) {
            if (typeof enabledState === 'boolean') savedStates[name] = enabledState;
          }
        }
      }
    }
  } catch (err) {
    console.error('[actions-bus] cannot load toggle state:', err.message || err);
  }

  function saveActionState(name, enabledState) {
    if (!stateFile) return;
    savedStates[name] = !!enabledState;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(savedStates, null, 2));
    } catch (err) {
      console.error('[actions-bus] cannot save toggle state:', err.message || err);
    }
  }

  const bus = servicesApi.actionBus && typeof servicesApi.actionBus.emit === 'function'
    ? servicesApi.actionBus
    : createActionsBus({
        initialActionStates: savedStates,
        onActionStateChange: saveActionState,
        onError(err, entry) {
          console.error('[actions-bus]', err.message || err, entry?.event || entry);
        }
      });

  servicesApi.actionBus = bus;

  const enabled = cfg.enabled !== false;
  if (enabled && Array.isArray(cfg.actions)) {
    bus.configure(cfg.actions);
  } else {
    bus.configure([]);
  }
  settings.onApply('actions-bus', ({ config }) => {
    bus.configure(config?.enabled !== false && Array.isArray(config?.actions) ? config.actions : []);
    for (const win of (require('electron').BrowserWindow?.getAllWindows?.() || [])) {
      if (!win.isDestroyed()) win.webContents.send('actions-bus:changed', bus.listNamedActions());
    }
  });

  if (ipcMain && typeof ipcMain.handle === 'function') {
    ipcMain.handle('actions-bus:list', () => bus.listNamedActions());
    ipcMain.handle('actions-bus:set-enabled', (_evt, name, enabledState) => {
      if (typeof name === 'string') {
        bus.setActionEnabled(name, !!enabledState);
      }
      return bus.listNamedActions();
    });
  }
}

function hookRenderer(ipcRenderer) {
  const container = document.getElementById('actions-bus-toggles');
  if (!container || !ipcRenderer) return;
  const visibleClass = 'actions-bus-toggles--visible';

  function render(list) {
    container.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0) {
      container.classList.remove(visibleClass);
      return;
    }
    container.classList.add(visibleClass);
    list.forEach((item) => {
      if (!item || typeof item.name !== 'string') return;
      const label = document.createElement('label');
      label.className = 'actions-bus-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.enabled !== false;
      checkbox.dataset.name = item.name;
      checkbox.addEventListener('change', () => {
        const checked = checkbox.checked;
        ipcRenderer
          .invoke('actions-bus:set-enabled', item.name, checked)
          .then((nextList) => {
            if (Array.isArray(nextList)) render(nextList);
            else refresh();
          })
          .catch(() => refresh());
      });
      const span = document.createElement('span');
      span.textContent = item.label || item.name;
      label.appendChild(checkbox);
      label.appendChild(span);
      container.appendChild(label);
    });
  }

  function refresh() {
    ipcRenderer
      .invoke('actions-bus:list')
      .then(render)
      .catch(() => {
        container.classList.remove(visibleClass);
        container.innerHTML = '';
      });
  }

  refresh();
  ipcRenderer.on('actions-bus:changed', (_event, list) => {
    if (Array.isArray(list)) render(list);
    else refresh();
  });
}

module.exports = { initService, hookRenderer };
