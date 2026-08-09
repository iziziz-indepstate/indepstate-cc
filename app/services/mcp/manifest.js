const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');

settings.register(
  'mcp',
  path.join(__dirname, 'config', 'mcp.json'),
  path.join(__dirname, 'config', 'mcp-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/mcp/config/mcp.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled !== true) return;
  const { start } = require('./index');

  start({ ...cfg, servicesApi })
    .then((serverInfo) => {
      servicesApi.mcp = serverInfo;
    })
    .catch((err) => {
      console.error('[mcp] failed to start', err);
    });
}

module.exports = { initService };
