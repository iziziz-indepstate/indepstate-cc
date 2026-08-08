const { DWXAdapter } = require('./comps/dwx');
const events = require('../events');

function initService(servicesApi = {}) {
  servicesApi.brokerage.registerAdapterFactory('dwx', (cfg = {}, providerName) => {
    const userHandler = cfg.event_handler || {};
    cfg.event_handler = {
      ...userHandler,
      on_bar_data(symbol, tf, time, open, high, low, close, vol) {
        try {
          events.emit('bar', { provider: providerName, symbol, tf, time, open, high, low, close, vol });
        } catch {}
        userHandler.on_bar_data?.(symbol, tf, time, open, high, low, close, vol);
      }
    };
    return new DWXAdapter(cfg);
  });
}

module.exports = { initService };
