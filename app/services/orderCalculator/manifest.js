const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { migrateLegacyRiskConfig } = require('./migrateLegacyRiskConfig');

const configPath = path.join(__dirname, 'config', 'order-calculator.json');
const descriptorPath = path.join(__dirname, 'config', 'order-calculator-settings-descriptor.json');

// Only the main process owns persisted config migrations. The renderer loads
// this manifest for hooks but must not race the main process for the same file.
if (process.type !== 'renderer') migrateLegacyRiskConfig();

settings.register(
  'order-calculator',
  configPath,
  descriptorPath
);

function initService(servicesApi = {}) {
  const orderCalculator = require('./index');
  // The singleton can be required before service manifests load, so refresh it
  // after the migration has written the new override.
  orderCalculator.configure(loadConfig(configPath));
  servicesApi.orderCalculator = orderCalculator;
}

settings.onApply('order-calculator', ({ config }) => {
  require('./index').configure(config);
});

module.exports = { initService };
