const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const executionRetry = require('./index');

settings.register(
  'execution-retry',
  path.join(__dirname, 'config', 'execution-retry.json'),
  path.join(__dirname, 'config', 'execution-retry-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/executionRetry/config/execution-retry.json');
  } catch {
    cfg = {};
  }
  executionRetry.configure(cfg);
  servicesApi.executionRetry = executionRetry;
  settings.onApply('execution-retry', ({ config }) => {
    executionRetry.configure(config);
  });
}

module.exports = { initService };
