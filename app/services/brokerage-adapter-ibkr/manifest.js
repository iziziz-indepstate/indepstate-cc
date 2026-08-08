const { IBKRAdapter } = require('./comps/ibkr');

function initService(servicesApi = {}) {
  servicesApi.brokerage.registerAdapterFactory('ibkr', (cfg = {}, providerName) => new IBKRAdapter(cfg, providerName || 'ibkr'));
}

module.exports = { initService };
