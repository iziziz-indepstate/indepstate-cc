const loadConfig = require('../../../config/load');

function buildChartComposer(cfg = {}) {
  const type = String(cfg.type || '').toLowerCase();
  switch (type) {
    case 'tv': {
      const { TvChartImageComposer } = require('./tv');
      return new TvChartImageComposer(cfg);
    }
    default:
      console.warn('[chartImages] unknown chart composer type', type);
      return null;
  }
}

let defaultComposer = null;
let layout1D;
let layout5M;
function configure(cfg = {}) {
  const def = cfg && cfg.default;
  if (def) {
    ({ layout1D, layout5M } = def);
    const { layout1D: _1, layout5M: _5, ...svcCfg } = def;
    defaultComposer = buildChartComposer(svcCfg);
  } else {
    defaultComposer = null;
    layout1D = undefined;
    layout5M = undefined;
  }
  return defaultComposer;
}
try {
  configure(loadConfig('../services/dealTrackers-chartImages/config/chart-images.json'));
} catch (e) {
  defaultComposer = null;
}

function compose1D(symbol) {
  if (!defaultComposer || !layout1D || !symbol) return undefined;
  try {
    return defaultComposer.compose(symbol, layout1D);
  } catch (e) {
    console.error('chart compose failed', e);
    return undefined;
  }
}

function compose5M(symbol) {
  if (!defaultComposer || !layout5M || !symbol) return undefined;
  try {
    return defaultComposer.compose(symbol, layout5M);
  } catch (e) {
    console.error('chart compose failed', e);
    return undefined;
  }
}

module.exports = { buildChartComposer, configure, compose1D, compose5M };
Object.defineProperty(module.exports, 'defaultComposer', { enumerable: true, get: () => defaultComposer });
