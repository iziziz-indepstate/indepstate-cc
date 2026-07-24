const dealTrackers = require('./comps');
const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');

settings.register(
  'deal-trackers',
  path.join(__dirname, 'config', 'deal-trackers.json'),
  path.join(__dirname, 'config', 'deal-trackers-settings-descriptor.json')
);

/**
 * @param {import('../servicesApi').ServicesApi} servicesApi
 */
function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/dealTrackers/config/deal-trackers.json');
  } catch {
    cfg = {};
  }
  dealTrackers.init(cfg.enabled === false ? {} : cfg);
  servicesApi.dealTrackers = dealTrackers;
  settings.onApply('deal-trackers', ({ config }) => {
    dealTrackers.init(config?.enabled === false ? {} : config);
  });
}

module.exports = { initService };
