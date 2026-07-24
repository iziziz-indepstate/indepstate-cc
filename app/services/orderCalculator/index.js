const loadConfig = require('../../config/load');
const { detectInstrumentType } = require('../instruments');

function finiteNumber(value) {
  if (value == null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizedSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

class OrderCalculator {
  constructor({ config, tradeRules } = {}) {
    this.config = config || this._loadDefaultConfig();
    this.tradeRules = tradeRules;
  }

  configure(config = {}) {
    this.config = config && typeof config === 'object' ? JSON.parse(JSON.stringify(config)) : {};
    return this;
  }

  _loadDefaultConfig() {
    try {
      return loadConfig('../services/orderCalculator/config/order-calculator.json');
    } catch (e) {
      return {
        profitRate: 3,
        riskUsd: {
          byInstrumentType: { EQ: 50, FX: 50, CX: 0.2 },
          bySymbol: {}
        }
      };
    }
  }

  // Resolve the shared card risk default. Symbol overrides take precedence over
  // instrument defaults; legacy environment variables override only the
  // corresponding instrument default.
  defaultRiskUsd({ symbol, instrumentType } = {}) {
    const riskConfig = this.config?.riskUsd || {};
    const wantedSymbol = normalizedSymbol(symbol);
    const bySymbol = riskConfig.bySymbol;
    if (wantedSymbol && bySymbol && typeof bySymbol === 'object' && !Array.isArray(bySymbol)) {
      const matchedKey = Object.keys(bySymbol)
        .find(key => normalizedSymbol(key) === wantedSymbol);
      if (matchedKey) {
        const symbolRisk = finiteNumber(bySymbol[matchedKey]);
        if (symbolRisk !== undefined) return symbolRisk;
      }
    }

    const explicitType = String(instrumentType || '').trim().toUpperCase();
    const type = explicitType || detectInstrumentType(wantedSymbol);
    const envName = type === 'CX'
      ? 'DEFAULT_CX_STOP_USD'
      : (type === 'EQ' || type === 'FX' ? 'DEFAULT_EQUITY_STOP_USD' : '');
    const envRisk = envName ? finiteNumber(process.env[envName]) : undefined;
    if (envRisk !== undefined) return envRisk;

    const byInstrumentType = riskConfig.byInstrumentType;
    if (!byInstrumentType || typeof byInstrumentType !== 'object') return undefined;
    const matchedType = Object.keys(byInstrumentType)
      .find(key => String(key).trim().toUpperCase() === type);
    return matchedType ? finiteNumber(byInstrumentType[matchedType]) : undefined;
  }

  // Calculate stop loss points from entry and stop prices
  stopPts({ tickSize, symbol, entryPrice, stopPrice, instrumentType }) {
    const { toPoints } = require('../instrumentInfo/points');
    let pts = toPoints(tickSize, symbol, Math.abs(entryPrice - stopPrice), entryPrice);

    const tr = this.tradeRules;
    const minRule = tr?.rules?.find(r => r.constructor.name === 'MinStopPointsRule');
    if (minRule) {
      const minPts = minRule._min({ instrumentType });
      if (Number.isFinite(minPts) && Number.isFinite(pts) && pts < minPts) {
        pts = minPts;
      }
    }
    return pts;
  }

  // Default take profit is triple the stop points or based on config profit rate
  takePts(stopPts) {
    const rate = this.config?.profitRate ?? 3;
    return Number.isFinite(stopPts) ? stopPts * rate : undefined;
  }

  // Calculate position size from risk in USD
  qty({ riskUsd, stopPts, tickSize, lot = 1, instrumentType, quantityStep }) {
    if (Number.isFinite(riskUsd) && riskUsd > 0 && Number.isFinite(stopPts) && stopPts > 0) {
      const tick = Number(tickSize);
      const step = Number(quantityStep);
      const stepOr = fallback => (Number.isFinite(step) && step > 0 ? step : fallback);
      const floorToStep = (value, fallbackStep) => {
        const s = stepOr(fallbackStep);
        return Math.floor(value / s) * s;
      };
      let q;
      if (instrumentType === 'FX') {
        const safeTick = Number.isFinite(tick) && tick > 0 ? tick : 1;
        const lotSize = Number(lot) || 100000;
        q = floorToStep((riskUsd / safeTick) / stopPts / lotSize, 0.01);
      } else if (instrumentType === 'CX') {
        if (!Number.isFinite(tick) || tick <= 0) return 0;
        const lotSize = Number(lot) || 1;
        q = floorToStep((riskUsd / tick) / stopPts / lotSize, 0.001);
      } else {
        const safeTick = Number.isFinite(tick) && tick > 0 ? tick : 1;
        q = floorToStep((riskUsd / safeTick) / stopPts, 1);
      }
      if (!Number.isFinite(q) || q < 0) q = 0;
      return Number(q.toFixed(10));
    }
    return 0;
  }
}

function buildOrderCalculator(cfg = {}, servicesApi = require('../servicesApi')) {
  return new OrderCalculator({
    config: cfg,
    get tradeRules() { return servicesApi.tradeRules; }
  });
}

let cfg = {};
try { cfg = loadConfig('../services/orderCalculator/config/order-calculator.json'); }
catch { cfg = {}; }

module.exports = buildOrderCalculator(cfg);
module.exports.OrderCalculator = OrderCalculator;
module.exports.buildOrderCalculator = buildOrderCalculator;
