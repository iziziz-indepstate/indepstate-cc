const path = require('path');
const settings = require('../settings');
const tradeRules = require('./index');

settings.register(
  'trade-rules',
  path.join(__dirname, 'config', 'trade-rules.json'),
  path.join(__dirname, 'config', 'trade-rules-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  servicesApi.tradeRules = tradeRules;
}

settings.onApply('trade-rules', ({ config }) => {
  tradeRules.configure(config);
});

module.exports = { initService };
