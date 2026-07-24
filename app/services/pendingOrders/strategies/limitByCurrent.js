const { B1_TAIL } = require('./consolidation');
const {
  normalizeBar,
  dedupeBars,
  sortBarsAsc,
  mergeBars,
  loadAndMergeHistory
} = require('./historyUtils');

function firstFinite(values) {
  for (const v of values) {
    if (Number.isFinite(v)) return v;
  }
  return null;
}

class LimitByCurrentStrategy {
  constructor({
    price,
    side,
    stoppLossRule = B1_TAIL,
    priceSource = 'bid',
    historyBars = 15,
    historyTimeframe = 'M1',
    historyLoader,
    getQuote,
    bars,
    symbol,
    tickSize,
    stopOffsetPts
  } = {}) {
    this.price = Number(price);
    this.side = side;
    this.stoppLossRule = typeof stoppLossRule === 'function' ? stoppLossRule : B1_TAIL;
    this.priceSource = typeof priceSource === 'string' ? priceSource.toLowerCase() : 'bid';
    this.historyBars = Math.max(1, Number(historyBars) || 15);
    this.historyTimeframe = typeof historyTimeframe === 'string' && historyTimeframe ? historyTimeframe : 'M1';
    this.historyLoader = typeof historyLoader === 'function' ? historyLoader : null;
    this.getQuote = typeof getQuote === 'function' ? getQuote : async () => null;
    this.symbol = symbol;
    this.tickSize = Number(tickSize);
    this.stopOffsetPts = Number(stopOffsetPts);
    this.done = false;
    this.cachedSeq = null;
    this.initialBars = Array.isArray(bars)
      ? bars.map(normalizeBar).filter(Boolean)
      : null;
    this.latestBar = null;
    this.historyLoadPromise = null;
  }

  async onBar(bar) {
    if (this.done) return null;
    const normalized = normalizeBar(bar);
    if (normalized) {
      this.latestBar = normalized;
      this._addInitialBar(normalized);
    }

    const quote = await this._safeGetQuote();
    const currentPrice = this._pickPrice(quote);
    if (!Number.isFinite(currentPrice)) return null;

    if (!this._isBeyondLevel(currentPrice)) return null;

    const seq = await this._getSequence();
    if (!seq || seq.length === 0) return null;

    const stopLoss = this.stoppLossRule(seq, this.side, this.price, {
      tickSize: this.tickSize,
      stopOffsetPts: this.stopOffsetPts,
      entryPrice: currentPrice
    });
    if (!Number.isFinite(stopLoss)) return null;

    this.done = true;
    return { limitPrice: currentPrice, stopLoss };
  }

  async _safeGetQuote() {
    try {
      const res = await this.getQuote(this.symbol);
      return res || null;
    } catch (err) {
      console.error('limitByCurrent: getQuote failed', err);
      return null;
    }
  }

  _addInitialBar(bar) {
    if (!bar) return;
    if (!this.initialBars) this.initialBars = [];
    if (bar.time != null) {
      const idx = this.initialBars.findIndex(b => b.time != null && b.time === bar.time);
      if (idx >= 0) {
        this.initialBars[idx] = bar;
      } else {
        this.initialBars.push(bar);
      }
    } else {
      this.initialBars.push(bar);
    }
    if (this.initialBars.length > this.historyBars * 2) {
      this.initialBars = this.initialBars.slice(-this.historyBars * 2);
    }
  }

  async _loadHistoryOnce() {
    if (!this.historyLoader) return;
    if (this.historyLoadPromise) return this.historyLoadPromise;
    this.historyLoadPromise = (async () => {
      try {
        this.initialBars = await loadAndMergeHistory({
          historyLoader: this.historyLoader,
          historyTimeframe: this.historyTimeframe,
          historyLimit: this.historyBars,
          price: this.price,
          side: this.side,
          symbol: this.symbol,
          existingBars: this.initialBars,
          normalizeBar,
          mergeBars,
          maxBars: this.historyBars * 2
        });
      } catch (err) {
        console.error('limitByCurrent: historyLoader failed', err);
        this.historyLoadPromise = null;
      }
    })();
    return this.historyLoadPromise;
  }

  async _getSequence() {
    if (this.cachedSeq) return this.cachedSeq;
    const initialCount = Array.isArray(this.initialBars) ? this.initialBars.length : 0;
    if (this.historyLoader && initialCount < this.historyBars) {
      await this._loadHistoryOnce();
    }
    let bars = Array.isArray(this.initialBars) ? [...this.initialBars] : [];
    if (this.latestBar) bars.push(this.latestBar);
    if (!bars.length) return null;
    bars = dedupeBars(bars);
    bars = sortBarsAsc(bars);
    if (bars.length > this.historyBars) {
      bars = bars.slice(-this.historyBars);
    }

    const breakoutIdx = this._findBreakoutIndex(bars);
    if (breakoutIdx == null) return null;
    const seq = bars.slice(breakoutIdx);
    this.cachedSeq = seq;
    return seq;
  }

  _findBreakoutIndex(bars) {
    if (!Array.isArray(bars) || !bars.length) return null;
    let prevClose = null;
    for (let i = 0; i < bars.length; i++) {
      const close = bars[i]?.close;
      if (!Number.isFinite(close)) continue;
      if (this.side === 'long') {
        if (close > this.price && (prevClose == null || prevClose <= this.price)) return i;
      } else if (this.side === 'short') {
        if (close < this.price && (prevClose == null || prevClose >= this.price)) return i;
      }
      prevClose = close;
    }
    for (let i = bars.length - 1; i >= 0; i--) {
      const close = bars[i]?.close;
      if (this._isBeyondLevel(close)) return i;
    }
    return null;
  }

  _isBeyondLevel(value) {
    if (!Number.isFinite(value)) return false;
    if (this.side === 'long') return value > this.price;
    if (this.side === 'short') return value < this.price;
    return false;
  }

  _pickPrice(quote) {
    if (!quote || typeof quote !== 'object') {
      return this.latestBar?.close ?? null;
    }
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : Number(quote.price);
    const price = Number(quote.price);
    const close = this.latestBar?.close;

    switch (this.priceSource) {
      case 'ask':
        return firstFinite([ask, mid, price, bid, close]);
      case 'mid':
      case 'price':
        return firstFinite([mid, price, bid, ask, close]);
      case 'bid':
      default:
        return firstFinite([bid, mid, price, ask, close]);
    }
  }
}

module.exports = { LimitByCurrentStrategy };
