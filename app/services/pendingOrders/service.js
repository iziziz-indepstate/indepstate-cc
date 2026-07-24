class PendingOrderService {
  constructor({ createStrategy } = {}) {
    if (typeof createStrategy !== 'function') {
      throw new Error('createStrategy callback required');
    }
    this.createStrategy = createStrategy;
    this.orders = new Map();
    this.nextId = 1;
  }

  configureStrategies(createStrategy) {
    if (typeof createStrategy !== 'function') throw new Error('createStrategy callback required');
    this.createStrategy = createStrategy;
  }

  addOrder(opts = {}) {
    const {
      price,
      side,
      strategy = 'consolidation',
      tickSize,
      bars,
      rangeRule,
      dealPriceRule,
      stoppLossRule,
      stopOffsetPts,
      priceSource,
      historyBars,
      historyTimeframe,
      historyLoader,
      getQuote,
      symbol,
      onExecute,
      onCancel
    } = opts;
    const params = { price, side };
    if (tickSize != null) params.tickSize = tickSize;
    if (bars != null) params.bars = bars;
    if (rangeRule != null) params.rangeRule = rangeRule;
    if (dealPriceRule != null) params.dealPriceRule = dealPriceRule;
    if (stoppLossRule != null) params.stoppLossRule = stoppLossRule;
    if (stopOffsetPts != null) params.stopOffsetPts = stopOffsetPts;
    if (priceSource != null) params.priceSource = priceSource;
    if (historyBars != null) params.historyBars = historyBars;
    if (historyTimeframe != null) params.historyTimeframe = historyTimeframe;
    if (historyLoader != null) params.historyLoader = historyLoader;
    if (getQuote != null) params.getQuote = getQuote;
    if (symbol != null) params.symbol = symbol;
    const strategyInst = this.createStrategy(strategy, params);
    const id = this.nextId++;
    this.orders.set(id, { id, side, strategy: strategyInst, onExecute, onCancel });
    return id;
  }

  cancelOrder(id) {
    this.orders.delete(id);
  }

  onBar(bar) {
    for (const [id, order] of Array.from(this.orders.entries())) {
      try {
        const res = order.strategy.onBar(bar);
        this.#handleResult(id, order, res);
      } catch (err) {
        console.error('pending strategy error', err);
      }
    }
  }

  #handleResult(id, order, res) {
    if (!res) return;
    if (typeof res.then === 'function') {
      res.then(value => {
        this.#handleResult(id, order, value);
      }).catch(err => {
        console.error('pending strategy async error', err);
      });
      return;
    }
    if (!this.orders.has(id)) return;
    this.orders.delete(id);
    if (res.limitPrice != null && res.stopLoss != null) {
      if (typeof order.onExecute === 'function') {
        order.onExecute({ id, side: order.side, ...res });
      }
    } else if (res.cancel && typeof order.onCancel === 'function') {
      order.onCancel({ id, side: order.side });
    }
  }
}

module.exports = { PendingOrderService };
