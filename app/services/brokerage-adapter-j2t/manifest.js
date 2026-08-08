const { J2TExecutionAdapter } = require('./comps/j2t');

function initService(servicesApi = {}) {
  servicesApi.brokerage.registerAdapterFactory('j2t', (cfg = {}) => new J2TExecutionAdapter(cfg));
}

module.exports = { initService };
