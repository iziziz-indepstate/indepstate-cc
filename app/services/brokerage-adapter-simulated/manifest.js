const { SimulatedAdapter } = require('./comps/simulated');

function initService(servicesApi = {}) {
  servicesApi.brokerage.registerAdapterFactory('simulated', (cfg = {}) => new SimulatedAdapter(cfg));
}

module.exports = { initService };
