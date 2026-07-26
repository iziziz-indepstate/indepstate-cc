const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const settings = require('../settings');
const { Command } = require('../commands/base');
const { createLevelTrackService } = require('.');

settings.register(
  'level-track',
  path.join(__dirname, 'config', 'level-track.json'),
  path.join(__dirname, 'config', 'level-track-settings-descriptor.json')
);

class LevelTrackCommand extends Command {
  constructor(openWindow) {
    super(['levelTrack', 'lt']);
    this.openWindow = openWindow;
  }

  run() {
    if (typeof this.openWindow !== 'function') {
      return { ok: false, error: 'LevelTrack window is not available' };
    }
    this.openWindow();
    return { ok: true };
  }
}

function initService(servicesApi = {}) {
  const { config } = settings.readConfig('level-track') || {};
  let levelTrackWindow = null;
  let refreshTimer = null;

  function sendState(data) {
    if (!levelTrackWindow || levelTrackWindow.isDestroyed()) return;
    levelTrackWindow.webContents.send('level-track:state', data || service.snapshot());
  }

  const service = createLevelTrackService({
    config,
    instrumentInfo: servicesApi.instrumentInfo,
    saveConfig: async nextConfig => settings.saveAndApplyConfig('level-track', nextConfig),
    emitState: sendState
  });

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    const snapshot = service.snapshot();
    const ms = Number(snapshot.config.refreshMs) || 1000;
    refreshTimer = setInterval(() => {
      service.refreshAll().catch(err => {
        console.error('[levelTrack] refresh failed:', err?.message || err);
      });
    }, ms);
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  }

  function openWindow() {
    if (levelTrackWindow && !levelTrackWindow.isDestroyed()) {
      levelTrackWindow.show();
      levelTrackWindow.focus();
      sendState();
      return levelTrackWindow;
    }
    levelTrackWindow = new BrowserWindow({
      width: 980,
      height: 560,
      title: 'LevelTrack',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    levelTrackWindow.on('closed', () => {
      levelTrackWindow = null;
    });
    levelTrackWindow.webContents.on('did-finish-load', () => sendState());
    levelTrackWindow.loadFile(path.join(__dirname, 'window.html'));
    return levelTrackWindow;
  }

  servicesApi.levelTrack = service;
  servicesApi.levelOrder?.registerLevelResolver?.('levelTrack', args => service.resolveLevel(args));
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  servicesApi.commands.push(new LevelTrackCommand(openWindow));

  settings.onApply('level-track', ({ config: nextConfig }) => {
    service.configure(nextConfig || {});
    scheduleRefresh();
  });

  ipcMain.handle('level-track:list', () => service.snapshot());
  ipcMain.handle('level-track:refresh', async (_evt, key) => {
    if (key) return service.refreshGroup(key);
    return service.refreshAll();
  });
  ipcMain.handle('level-track:save', async (_evt, nextConfig) => service.save(nextConfig || {}));

  scheduleRefresh();
}

module.exports = { initService, LevelTrackCommand };
