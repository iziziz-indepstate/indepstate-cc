const loadConfig = require('../../config/load');

const TradeRule = require('./tradeRule');
const { MaxOrderPriceDeviationRule } = require('./maxOrderPriceDeviation');
const { MinStopPointsRule } = require('./minStopPoints');
const { MaxQtyRule } = require('./maxQty');

class TradeRules {
  constructor(rules = []) {
    this.rules = rules;
  }

  validate(card = {}, quote) {
    for (const rule of this.rules) {
      const res = rule.validate(card, quote);
      if (!res.ok) return res;
    }
    return { ok: true };
  }
}

function buildTradeRules(cfg = {}) {
  const rules = [];
  const { rules: ruleCfgs = {} } = cfg;

  if (ruleCfgs.maxOrderPriceDeviation && ruleCfgs.maxOrderPriceDeviation.enabled !== false) {
    rules.push(new MaxOrderPriceDeviationRule(ruleCfgs.maxOrderPriceDeviation));
  }

  if (ruleCfgs.minStopPoints && ruleCfgs.minStopPoints.enabled !== false) {
    rules.push(new MinStopPointsRule(ruleCfgs.minStopPoints));
  }

  if (ruleCfgs.maxQty && ruleCfgs.maxQty.enabled !== false) {
    rules.push(new MaxQtyRule(ruleCfgs.maxQty));
  }

  return new TradeRules(rules);
}

let cfg = {};
try { cfg = loadConfig('../services/tradeRules/config/trade-rules.json'); }
catch { cfg = {}; }

const singleton = buildTradeRules(cfg);
singleton.configure = function configure(next = {}) {
  this.rules = buildTradeRules(next).rules;
  return this;
};

module.exports = singleton;
module.exports.TradeRules = TradeRules;
module.exports.TradeRule = TradeRule;
module.exports.MaxOrderPriceDeviationRule = MaxOrderPriceDeviationRule;
module.exports.MinStopPointsRule = MinStopPointsRule;
module.exports.MaxQtyRule = MaxQtyRule;
module.exports.buildTradeRules = buildTradeRules;
