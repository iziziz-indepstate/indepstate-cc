const { add, dist } = require('../actions-bus');
const { stripExchangePrefix } = require('../instruments');

function hasBlankArg(values) {
  return values.some(value => typeof value === 'string' && value.trim() === '');
}

function createInstrumentInfoActionFunctions(instrumentInfo) {
  function distPts(a, b, payload = {}) {
    const gap = dist(a, b);
    if (gap === '') return '';
    const symbol = stripExchangePrefix(payload?.symbol);
    const context = {
      provider: payload?.provider || payload?.meta?.provider,
      symbol,
      instrumentType: payload?.instrumentType,
      payload
    };
    const calculate = () => {
      const value = instrumentInfo.toPoints(context, gap, {
        explicitTickSize: payload?.tickSize,
        deltaTokenForFallback: String(gap)
      });
      return Number.isFinite(value) ? value : '';
    };
    if (typeof instrumentInfo.get !== 'function' || instrumentInfo.peek?.(context)) {
      return calculate();
    }
    return instrumentInfo.get(context, { quote: false, timeoutMs: 5000 })
      .then(calculate)
      .catch(calculate);
  }

  function distPtsPlus(a, b, extra, payload = {}) {
    if (hasBlankArg([extra])) return '';
    const finish = rawPoints => {
      if (rawPoints === '') return '';
      const points = Number(rawPoints);
      const extraPoints = Number(extra);
      if (!Number.isFinite(points) || !Number.isFinite(extraPoints)) return '';
      return add(points, extraPoints);
    };
    const rawPoints = distPts(a, b, payload);
    return rawPoints && typeof rawPoints.then === 'function'
      ? rawPoints.then(finish)
      : finish(rawPoints);
  }

  return { distPts, distPtsPlus };
}

module.exports = { createInstrumentInfoActionFunctions };
