const path = require('path');
const { BrowserWindow, clipboard } = require('electron');
const settings = require('../settings');
const { LevelsListCommand } = require('.');

settings.register(
  'levels-list',
  path.join(__dirname, 'config', 'levels-list.json'),
  path.join(__dirname, 'config', 'levels-list-settings-descriptor.json')
);

function isMainAppWindow(win) {
  if (!win || win.isDestroyed?.()) return false;
  const url = String(win.webContents?.getURL?.() || '');
  return /(?:^|\/|\\)index\.html(?:$|[?#])/i.test(url);
}

function getOrderWindow(context = {}) {
  const sender = context?.sender;
  const sourceWindow = sender && BrowserWindow.fromWebContents?.(sender);
  if (isMainAppWindow(sourceWindow)) return sourceWindow;
  return (BrowserWindow.getAllWindows?.() || []).find(isMainAppWindow) || null;
}

async function readVisibleOrderRows(context = {}) {
  const win = getOrderWindow(context);
  if (!win) return null;
  return win.webContents.executeJavaScript(
    'typeof window.__isccGetVisibleOrderRows === "function" ? window.__isccGetVisibleOrderRows() : null',
    true
  );
}

function initService(servicesApi = {}) {
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  servicesApi.commands.push(new LevelsListCommand({
    getRows: readVisibleOrderRows,
    writeText: text => clipboard.writeText(String(text || '')),
    getConfig() {
      return (settings.readConfig('levels-list') || {}).config || {};
    }
  }));
}

module.exports = {
  initService,
  isMainAppWindow,
  getOrderWindow,
  readVisibleOrderRows
};
