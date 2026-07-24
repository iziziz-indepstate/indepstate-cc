const { normalizeBar, mergeBars, loadAndMergeHistory } = require('./historyUtils');

const ALWAYS_TRUE = () => true;

// KNOWN_EXTREMUM selects the most favorable extreme from the bar sequence
// (highest high for longs, lowest low for shorts) as the target price.
function KNOWN_EXTREMUM(bars, side, _price) {
  return side === 'long'
    ? Math.max(...bars.map(b => b.high))
    : Math.min(...bars.map(b => b.low));
}

// OPPOSITE_EXTREMUM selects the most favorable extreme from the bar sequence
// (highest high for shorts, lowest low for longs) as the stop price.
function OPPOSITE_EXTREMUM(bars, side, _price) {
  return side === 'short'
    ? Math.max(...bars.map(b => b.high))
    : Math.min(...bars.map(b => b.low));
}

// B1_TAIL uses the opposite-side tail of the breakout bar as the stop price.
function B1_TAIL(bars, side, _price) {
  const b1 = bars[0];
  return side === 'long' ? b1.low : b1.high;
}

// LEVEL_OFFSET anchors the stop on the opposite side of the watched level.
// The pending hub later converts this stop price to the complete distance from
// the strategy's actual entry price, so that distance includes both the move
// from entry to level and the configured offset beyond the level.
function LEVEL_OFFSET(_bars, side, price, { tickSize, stopOffsetPts } = {}) {
  const level = Number(price);
  const tick = Number(tickSize);
  const offset = Number(stopOffsetPts);
  if (!Number.isFinite(level)) throw new Error('LEVEL_OFFSET requires a finite level');
  if (!Number.isFinite(tick) || tick <= 0) throw new Error('LEVEL_OFFSET requires tickSize > 0');
  if (!Number.isFinite(offset) || offset <= 0) throw new Error('LEVEL_OFFSET requires stopOffsetPts > 0');
  if (side === 'long') return level - offset * tick;
  if (side === 'short') return level + offset * tick;
  throw new Error(`LEVEL_OFFSET requires side long or short, received: ${side}`);
}

// B1_10p_GAP offsets the entry price by 10% of the breakout bar range
// (minimum 0.01) plus 0.02 to place the limit order.
function B1_10p_GAP(bars, side, price) {
  const b1 = bars[0];
  const range = b1.high - b1.low;
  const gap = Math.max(range * 0.1, 0.01) + 0.02;
  return side === 'long' ? price + gap : price - gap;
}

function B1_RANGE_CONSOLIDATION(price, side, bars) {
  const b1 = bars[0];
  const range = b1.high - b1.low;
  if (bars.length <= 1) return true;
  if (side === 'long') {
    return Math.max(...bars.slice(1).map(b => b.high)) - price <= range;
  }
  return price - Math.min(...bars.slice(1).map(b => b.low)) <= range;
}

class ConsolidationStrategy {
  constructor({
    price,
    side,
    bars = 3,
    rangeRule = ALWAYS_TRUE,
    dealPriceRule = KNOWN_EXTREMUM,
    stoppLossRule = B1_TAIL,
    historyLoader,
    historyTimeframe = 'M1',
    historyPreload = false,
    symbol,
    tickSize,
    stopOffsetPts
  } = {}) {
    this.price = Number(price);
    this.side = side;
    this.barCount = Math.max(1, Number(bars) || 3);
    this.rangeRule = rangeRule;
    this.dealPriceRule = dealPriceRule;
    this.stoppLossRule = stoppLossRule;
    this.historyTimeframe = typeof historyTimeframe === 'string' && historyTimeframe ? historyTimeframe : 'M1';
    this.historyLoader = typeof historyLoader === 'function' ? historyLoader : null;
    this.historyPreload = Boolean(historyPreload);
    this.symbol = symbol;
    this.tickSize = Number(tickSize);
    this.stopOffsetPts = Number(stopOffsetPts);
    this.initialBars = [];
    this.done = false;
    this.historyLoadPromise = null;
    if (this.historyPreload && this.historyLoader) {
      this._loadHistoryOnce();
    }
  }

  async onBar(bar) {
    if (this.done) return null;
    const normalized = normalizeBar(bar);
    if (normalized) {
      this.initialBars = mergeBars(this.initialBars, normalized, this.barCount * 2);
    }
    if (this.historyPreload && this.historyLoader && this._getAvailableCount() < this.barCount) {
      await this._loadHistoryOnce();
    }
    const seq = this._getSequence();
    if (!seq) return null;
    const b1 = seq[0];
    const p = this.price;
    let ok = false;
    if (this.side === 'long') {
      ok = b1.close > p && seq.slice(1).every(b => b.open > p && b.close > p && b.low >= p);
    } else {
      ok = b1.close < p && seq.slice(1).every(b => b.open < p && b.close < p && b.high <= p);
    }
    if (!ok) return null;
    if (!this.rangeRule(p, this.side, seq)) return null;
    this.done = true;
    const limitPrice = this.dealPriceRule(seq, this.side, p);
    const stopLoss = this.stoppLossRule(seq, this.side, p, {
      tickSize: this.tickSize,
      stopOffsetPts: this.stopOffsetPts,
      entryPrice: limitPrice
    });
    return { limitPrice, stopLoss };
  }

  _getAvailableCount() {
    return this.initialBars.length;
  }

  _getSequence() {
    if (!this.initialBars.length) return null;
    if (this.initialBars.length < this.barCount) return null;
    return this.initialBars.slice(-this.barCount);
  }

  async _loadHistoryOnce() {
    if (!this.historyLoader) return;
    if (this.historyLoadPromise) return this.historyLoadPromise;
    this.historyLoadPromise = (async () => {
      try {
        this.initialBars = await loadAndMergeHistory({
          historyLoader: this.historyLoader,
          historyTimeframe: this.historyTimeframe,
          historyLimit: this.barCount,
          price: this.price,
          side: this.side,
          symbol: this.symbol,
          existingBars: this.initialBars,
          normalizeBar,
          mergeBars,
          maxBars: this.barCount * 2
        });
      } catch (err) {
        console.error('consolidation: historyLoader failed', err);
        this.historyLoadPromise = null;
      }
    })();
    return this.historyLoadPromise;
  }
}

module.exports = {
  ConsolidationStrategy,
  B1_RANGE_CONSOLIDATION,
  KNOWN_EXTREMUM,
  OPPOSITE_EXTREMUM,
  B1_TAIL,
  LEVEL_OFFSET,
  B1_10p_GAP
};
