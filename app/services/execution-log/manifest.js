const path = require('path');

const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createExecutionLogService } = require('./index');
let currentService = null;
let quitHookRegistered = false;

settings.register(
  'execution-log',
  path.join(__dirname, 'config', 'execution-log.json'),
  path.join(__dirname, 'config', 'execution-log-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/execution-log/config/execution-log.json');
  } catch {
    cfg = {};
  }
  function replace(config = {}) {
    if (config.enabled === false) {
      currentService?.stop();
      currentService = null;
      delete servicesApi.executionLog;
      return;
    }
    const next = createExecutionLogService(config);
    next.start();
    currentService?.stop();
    currentService = next;
    servicesApi.executionLog = next;
  }
  try { replace(cfg); }
  catch (err) { console.error('[execution-log] failed to start:', err.message); }
  settings.onApply('execution-log', ({ config }) => replace(config));

  let electronApp;
  try { ({ app: electronApp } = require('electron')); } catch {}
  if (electronApp && !quitHookRegistered) {
    quitHookRegistered = true;
    electronApp.on('quit', () => {
      try { currentService?.stop(); } catch {}
    });
  }
}

module.exports = { initService };
