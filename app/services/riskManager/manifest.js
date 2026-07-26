const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const settings = require('../settings');
const events = require('../events');
const { Command } = require('../commands/base');
const { createRiskManagerService } = require('.');

settings.register(
  'risk-manager',
  path.join(__dirname, 'config', 'risk-manager.json'),
  path.join(__dirname, 'config', 'risk-manager-settings-descriptor.json')
);

class RiskManagerCommand extends Command {
  constructor(openWindow) {
    super(['riskManager', 'rm']);
    this.openWindow = openWindow;
  }

  run() {
    if (typeof this.openWindow !== 'function') return { ok: false, error: 'Risk Manager window is not available' };
    this.openWindow();
    return { ok: true };
  }
}

function initService(servicesApi = {}) {
  const { config } = settings.readConfig('risk-manager') || {};
  let riskManagerWindow = null;
  let pollTimer = null;

  function sendState(data) {
    if (!riskManagerWindow || riskManagerWindow.isDestroyed()) return;
    riskManagerWindow.webContents.send('risk-manager:state', data || service.snapshot());
  }

  const service = createRiskManagerService({
    config,
    events,
    brokerage: servicesApi.brokerage,
    instrumentInfo: servicesApi.instrumentInfo,
    saveConfig: async nextConfig => settings.saveAndApplyConfig('risk-manager', nextConfig),
    emitState: sendState
  });

  function schedulePolling() {
    if (pollTimer) clearInterval(pollTimer);
    const snapshot = service.snapshot();
    if (snapshot.config.enabled === false) return;
    const ms = Number(snapshot.config.pollMs) || 1000;
    pollTimer = setInterval(() => {
      service.refreshAll().catch(err => {
        console.error('[riskManager] refresh failed:', err?.message || err);
      });
    }, ms);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function openWindow() {
    if (riskManagerWindow && !riskManagerWindow.isDestroyed()) {
      riskManagerWindow.show();
      riskManagerWindow.focus();
      sendState();
      return riskManagerWindow;
    }
    riskManagerWindow = new BrowserWindow({
      width: 1180,
      height: 720,
      title: 'Risk Manager',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    riskManagerWindow.on('closed', () => {
      riskManagerWindow = null;
    });
    riskManagerWindow.webContents.on('did-finish-load', () => sendState());
    riskManagerWindow.loadFile(path.join(__dirname, 'window.html'));
    return riskManagerWindow;
  }

  service.bindEvents();
  servicesApi.riskManager = service;
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  servicesApi.commands.push(new RiskManagerCommand(openWindow));

  settings.onApply('risk-manager', ({ config: nextConfig }) => {
    service.configure(nextConfig || {});
    schedulePolling();
  });

  ipcMain.handle('risk-manager:list', () => service.snapshot());
  ipcMain.handle('risk-manager:refresh', () => service.refreshAll());
  ipcMain.handle('risk-manager:save', async (_evt, nextConfig) => service.save(nextConfig || {}));
  ipcMain.handle('risk-manager:close-position', async (_evt, payload = {}) => {
    const key = payload.key || `${String(payload.provider || '').trim().toLowerCase()}:${String(payload.ticket || '').trim()}`;
    return service.closePosition(key, payload.reason || 'manual risk-manager close');
  });

  schedulePolling();
}

module.exports = { initService, RiskManagerCommand };
