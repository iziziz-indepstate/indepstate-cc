const { PendingOrderService } = require('./service');
const {
  ConsolidationStrategy,
  B1_RANGE_CONSOLIDATION,
  KNOWN_EXTREMUM,
  B1_TAIL,
  LEVEL_OFFSET,
  B1_10p_GAP
} = require('./strategies/consolidation');
const { FalseBreakStrategy } = require('./strategies/falseBreak');
const { LimitByCurrentStrategy } = require('./strategies/limitByCurrent');
const { PendingOrderHub, createPendingOrderHub } = require('./hub');
const { createStrategyFactory } = require('./factory');

function createPendingOrderService(opts = {}) {
  const createStrategy = opts.strategyFactory || createStrategyFactory(opts.strategyConfig, opts.strategies);
  return new PendingOrderService({ createStrategy });
}

module.exports = {
  createPendingOrderService,
  PendingOrderService,
  ConsolidationStrategy,
  B1_RANGE_CONSOLIDATION,
  KNOWN_EXTREMUM,
  B1_TAIL,
  LEVEL_OFFSET,
  B1_10p_GAP,
  FalseBreakStrategy,
  LimitByCurrentStrategy,
  PendingOrderHub,
  createPendingOrderHub,
  createStrategyFactory
};
