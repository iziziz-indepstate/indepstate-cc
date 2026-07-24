const brokerageAdapters = require('../brokerage/brokerageAdapters');
const { detectInstrumentType } = require('../instruments');

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function isBinanceCcxtProvider(config) {
  const adapter = String(config?.adapter || '').trim().toLowerCase();
  const exchangeId = String(config?.exchangeId || '').trim().toLowerCase();
  return (adapter === 'ccxt' || adapter.startsWith('ccxt-'))
    && ['binance', 'binanceusdm', 'binance-futures', 'binancefutures'].includes(exchangeId);
}

function findConfiguredMetadataPreloadProviders(brokerage) {
  const config = brokerage?.getExecutionConfig?.() || {};
  const providers = config.providers || {};
  const candidates = new Set();
  const cxProvider = normalizeProvider(config.byInstrumentType?.CX);
  if (cxProvider) candidates.add(cxProvider);
  else {
    const defaultProvider = normalizeProvider(config.default);
    if (defaultProvider) candidates.add(defaultProvider);
  }
  for (const [symbol, provider] of Object.entries(config.bySymbol || {})) {
    if (detectInstrumentType(String(symbol || '')) !== 'CX') continue;
    const normalized = normalizeProvider(provider);
    if (normalized) candidates.add(normalized);
  }
  return Array.from(candidates).filter(provider => isBinanceCcxtProvider(providers[provider]));
}

function prewarmConfiguredInstrumentMetadata(brokerage) {
  const providers = findConfiguredMetadataPreloadProviders(brokerage);
  const failures = [];
  for (const provider of providers) {
    try {
      brokerage.getAdapter(provider);
    } catch (error) {
      failures.push({ provider, error });
    }
  }
  if (failures.length) {
    const error = new Error(`CCXT metadata prewarm failed for: ${failures.map(item => item.provider).join(', ')}`);
    error.failures = failures;
    throw error;
  }
  return providers;
}

function initService(servicesApi = {}) {
  brokerageAdapters.ccxt = (config = {}) => {
    const { CCXTExecutionAdapter } = require('./comps/ccxt');
    return new CCXTExecutionAdapter(config);
  };
  servicesApi.instrumentInfo?.registerMetadataPrewarmer?.(
    'ccxt-binance-futures',
    () => prewarmConfiguredInstrumentMetadata(servicesApi.brokerage)
  );
}

module.exports = {
  initService,
  isBinanceCcxtProvider,
  findConfiguredMetadataPreloadProviders,
  prewarmConfiguredInstrumentMetadata
};
