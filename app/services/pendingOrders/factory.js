const loadConfig = require('../../config/load');
const {
  ConsolidationStrategy,
  B1_RANGE_CONSOLIDATION,
  KNOWN_EXTREMUM,
  OPPOSITE_EXTREMUM,
  B1_TAIL,
  LEVEL_OFFSET,
  B1_10p_GAP
} = require('./strategies/consolidation');
const { LimitByCurrentStrategy } = require('./strategies/limitByCurrent');
const { FalseBreakStrategy } = require('./strategies/falseBreak');

function createStrategyFactory(strategyConfig, extraStrategies = {}, extraHelpers = {}) {
  const cfg = strategyConfig || loadConfig('../services/pendingOrders/config/pending-strategies.json');
  const helpers = {
    B1_RANGE_CONSOLIDATION,
    KNOWN_EXTREMUM,
    OPPOSITE_EXTREMUM,
    B1_TAIL,
    LEVEL_OFFSET,
    B1_10p_GAP,
    ...extraHelpers
  };
  const classes = {
    consolidation: ConsolidationStrategy,
    falseBreak: FalseBreakStrategy,
    limitByCurrent: LimitByCurrentStrategy,
    ...extraStrategies
  };
  return function (name, params = {}) {
    const Strategy = classes[name];
    if (!Strategy) throw new Error(`Unknown strategy: ${name}`);
    const base = cfg?.[name] || {};
    const opts = { ...base, ...params };
    ['rangeRule', 'dealPriceRule', 'stoppLossRule'].forEach(key => {
      if (typeof opts[key] === 'string' && helpers[opts[key]]) {
        opts[key] = helpers[opts[key]];
      }
    });
    if (opts.stoppLossRule === LEVEL_OFFSET) {
      const tickSize = Number(opts.tickSize);
      const stopOffsetPts = Number(opts.stopOffsetPts);
      if (!Number.isFinite(tickSize) || tickSize <= 0) {
        throw new Error('LEVEL_OFFSET requires tickSize > 0');
      }
      if (!Number.isFinite(stopOffsetPts) || stopOffsetPts <= 0) {
        throw new Error('LEVEL_OFFSET requires stopOffsetPts > 0 from the order-card SL field');
      }
    }
    return new Strategy(opts);
  };
}

module.exports = { createStrategyFactory };
