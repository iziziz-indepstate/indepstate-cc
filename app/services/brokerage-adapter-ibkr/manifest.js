const brokerageAdapters = require('../brokerage/brokerageAdapters');
const { IBKRAdapter } = require('./comps/ibkr');

function initService() {
  brokerageAdapters.ibkr = (cfg = {}, providerName) => new IBKRAdapter(cfg, providerName || 'ibkr');
}

module.exports = { initService };
