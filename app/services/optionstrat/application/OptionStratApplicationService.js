const { buildOptionStratHedgePayload } = require('../hedge');
const { normalizeOrderPayload } = require('../../../application/execution');

class OptionStratApplicationService {
  constructor({
    servicesApi = {},
    getAdapter,
    wireAdapter = adapter => adapter,
    executionService,
    resolveProviderName
  } = {}) {
    this.servicesApi = servicesApi;
    this.getAdapter = getAdapter;
    this.wireAdapter = wireAdapter;
    this.executionService = executionService;
    this.resolveProviderName = resolveProviderName;
  }

  handleButtonEvent(payload = {}) {
    const { eventName, payload: eventPayload } = buildOptionStratHedgePayload(payload.action, payload.row || {});
    if (!eventPayload.hedgeOpenSide) {
      return { ok: false, reason: 'Unsupported OptionStrat strategy for hedge automation' };
    }
    if (this.servicesApi.actionBus && typeof this.servicesApi.actionBus.emit === 'function') {
      this.servicesApi.actionBus.emit(eventName, eventPayload);
      return { ok: true, event: eventName, payload: eventPayload };
    }
    return { ok: false, reason: 'actions-bus is not available' };
  }

  async estimate(payload = {}) {
    const order = normalizeOrderPayload({
      ...payload,
      instrumentType: 'OPT',
      provider: payload.provider || payload.meta?.provider || 'optionstrat'
    }, {
      servicesApi: this.servicesApi
    });
    const providerName = this.executionService?.resolveOrderProviderName
      ? this.executionService.resolveOrderProviderName(order)
      : this.resolveProviderName({
        payload: order,
        symbol: order?.symbol || order?.ticker,
        instrumentType: order?.instrumentType,
        meta: order?.meta
      });
    try {
      const adapter = this.getAdapter(providerName);
      this.wireAdapter(adapter, providerName);
      if (typeof adapter?.estimateOrder !== 'function') {
        return { status: 'unsupported', provider: providerName };
      }
      return await adapter.estimateOrder(order);
    } catch (err) {
      return { status: 'rejected', provider: providerName, reason: err?.message || String(err) };
    }
  }

  async valuation(payload = {}) {
    const providerName = payload.provider || payload.meta?.provider || 'optionstrat';
    const ticket = typeof payload.ticket === 'string' ? payload.ticket : String(payload.ticket || '');
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : (payload.symbol == null ? undefined : String(payload.symbol));
    if (!ticket) return { status: 'error', provider: providerName, reason: 'ticket required' };
    try {
      const adapter = this.getAdapter(providerName);
      this.wireAdapter(adapter, providerName);
      if (typeof adapter?.getStrategyValuation !== 'function') {
        return { status: 'unsupported', provider: providerName };
      }
      return await adapter.getStrategyValuation(ticket, symbol);
    } catch (err) {
      return { status: 'error', provider: providerName, reason: err?.message || String(err) };
    }
  }
}

function createOptionStratApplicationService(options = {}) {
  return new OptionStratApplicationService(options);
}

module.exports = {
  OptionStratApplicationService,
  createOptionStratApplicationService
};
