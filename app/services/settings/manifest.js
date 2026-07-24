const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const settings = require('./index');
const { listConfigs, readConfig, writeConfig, saveAndApplyConfig, reportApplyFailure, getRestartStatus } = settings;

settings.register(
  'services',
  path.join(__dirname, 'config', 'services.json'),
  path.join(__dirname, 'config', 'services-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  servicesApi.settings = { listConfigs, readConfig, writeConfig, saveAndApplyConfig, getRestartStatus, onApply: settings.onApply };
  ipcMain.handle('settings:list', () => listConfigs());
  ipcMain.handle('settings:get', (_evt, name) => readConfig(name));
  ipcMain.handle('settings:restart-status', () => getRestartStatus());
  ipcMain.handle('settings:renderer-failed', (_evt, name, paths, error) => reportApplyFailure(name, paths, error));
  ipcMain.handle('settings:set', async (_evt, name, data) => {
    const result = await saveAndApplyConfig(name, data);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:changed', result);
    }
    return result;
  });
}

module.exports = { initService };
