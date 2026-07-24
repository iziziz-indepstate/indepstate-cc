const { detectInstrumentType } = require('../instruments');
const { getAdapter, getExecutionConfig } = require('./adapterRegistry');

const HARD_FALLBACK_PROVIDER = 'simulated';

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return provider || '';
}

function normalizeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return symbol || '';
}

function firstProvider(...values) {
  for (const value of values) {
    const provider = normalizeProvider(value);
    if (provider) return provider;
  }
  return '';
}

function resolveContext(context = {}) {
  const payload = context.payload || {};
  const row = context.row || {};
  const meta = context.meta || payload.meta || row.meta || {};
  const symbol = normalizeSymbol(
    context.symbol ||
    context.ticker ||
    payload.symbol ||
    payload.ticker ||
    row.symbol ||
    row.ticker
  );
  const instrumentType = String(
    context.instrumentType ||
    payload.instrumentType ||
    row.instrumentType ||
    meta.instrumentType ||
    (symbol ? detectInstrumentType(symbol) : '')
  || '').trim().toUpperCase();

  return {
    payload,
    row,
    meta,
    symbol,
    instrumentType,
    explicitProvider: firstProvider(
      context.provider,
      payload.provider,
      row.provider,
      meta.provider
    )
  };
}

function findBySymbol(bySymbol = {}, symbol) {
  if (!symbol || !bySymbol || typeof bySymbol !== 'object') return null;
  for (const [key, value] of Object.entries(bySymbol)) {
    if (normalizeSymbol(key) === symbol) {
      const provider = normalizeProvider(value);
      if (provider) return { provider, matchedKey: key };
    }
  }
  return null;
}

function createProviderResolver({ getExecutionConfig: readConfig = getExecutionConfig, getAdapter: readAdapter = getAdapter } = {}) {
  function resolveProvider(context = {}) {
    const cfg = readConfig?.() || {};
    const resolved = resolveContext(context);

    if (resolved.explicitProvider) {
      return { provider: resolved.explicitProvider, source: 'explicit', matchedKey: 'provider' };
    }

    const bySymbol = findBySymbol(cfg.bySymbol, resolved.symbol);
    if (bySymbol) {
      return { provider: bySymbol.provider, source: 'bySymbol', matchedKey: bySymbol.matchedKey };
    }

    const byInstrumentType = cfg.byInstrumentType || {};
    if (resolved.instrumentType && Object.prototype.hasOwnProperty.call(byInstrumentType, resolved.instrumentType)) {
      const provider = normalizeProvider(byInstrumentType[resolved.instrumentType]);
      if (provider) {
        return { provider, source: 'byInstrumentType', matchedKey: resolved.instrumentType };
      }
    }

    const defaultProvider = normalizeProvider(cfg.default);
    if (defaultProvider) {
      return { provider: defaultProvider, source: 'default', matchedKey: 'default' };
    }

    return { provider: HARD_FALLBACK_PROVIDER, source: 'fallback', matchedKey: 'hardcoded' };
  }

  function resolveAdapter(context = {}) {
    const resolution = resolveProvider(context);
    return {
      ...resolution,
      adapter: readAdapter(resolution.provider)
    };
  }

  return { resolveProvider, resolveAdapter };
}

const defaultResolver = createProviderResolver();

module.exports = {
  createProviderResolver,
  normalizeProvider,
  normalizeSymbol,
  resolveProvider: defaultResolver.resolveProvider,
  resolveAdapter: defaultResolver.resolveAdapter
};
