const chartImages = require('./comps');
const path = require('path');
const settings = require('../settings');

settings.register(
  'chart-images',
  path.join(__dirname, 'config', 'chart-images.json'),
  path.join(__dirname, 'config', 'chart-images-settings-descriptor.json')
);

/**
 * @param {import('../servicesApi').ServicesApi} servicesApi
 */
function initService(servicesApi = {}) {
  servicesApi.dealTrackersChartImages = chartImages;
  settings.onApply('chart-images', ({ config }) => chartImages.configure(config));
}

module.exports = { initService };
