const { EventEmitter } = require('events');
const { detectInstrumentType } = require('../instruments');
const points = require('./points');

const DEFAULT_QUOTE_TTL_MS = 1000;
const DEFAULT_METADATA_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10000;

const METADATA_FIELDS = [
  'tickSize',
  'quantityStep',
  'minQty',
  'maxQty',
  'minNotional',
  'contractSize'
];

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function cloneSnapshot(record) {
  if (!record) return null;
  return {
    provider: record.provider,
    symbol: record.symbol,
    instrumentType: record.instrumentType,
    quote: { ...(record.quote || {}) },
    metadata: { ...(record.metadata || {}) },
    sources: { ...(record.sources || {}) },
    quoteUpdatedAt: record.quoteUpdatedAt || null,
    metadataUpdatedAt: record.metadataUpdatedAt || null
  };
}

function normalizeQuote(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const quote = {};
  for (const field of ['bid', 'ask', 'price']) {
    const value = finiteNumber(raw[field]);
    if (value !== undefined) quote[field] = value;
  }
  if (quote.price === undefined) {
    if (quote.bid !== undefined && quote.ask !== undefined) quote.price = (quote.bid + quote.ask) / 2;
    else if (quote.bid !== undefined) quote.price = quote.bid;
    else if (quote.ask !== undefined) quote.price = quote.ask;
  }
  const timestamp = finiteNumber(raw.timestamp ?? raw.time ?? raw.updatedAt);
  if (timestamp !== undefined) quote.timestamp = timestamp;
  return quote;
}

function normalizeMetadata(raw) {
  if (!raw || typeof raw !== 'object') return { metadata: {}, sources: {} };
  const metadata = {};
  const aliases = {
    tickSize: raw.tickSize ?? raw.minTick,
    quantityStep: raw.quantityStep ?? raw.stepSize ?? raw.lotStep,
    minQty: raw.minQty ?? raw.minQuantity,
    maxQty: raw.maxQty ?? raw.maxQuantity,
    minNotional: raw.minNotional,
    contractSize: raw.contractSize ?? raw.multiplier
  };
  for (const field of METADATA_FIELDS) {
    const value = positiveNumber(aliases[field]);
    if (value !== undefined) metadata[field] = value;
  }
  const sources = {};
  const rawSources = raw.sources && typeof raw.sources === 'object' ? raw.sources : {};
  for (const field of Object.keys(metadata)) {
    const source = rawSources[field] || (field === 'tickSize' ? raw.tickSource : undefined);
    if (source) sources[field] = String(source);
  }
  return { metadata, sources };
}

function withTimeout(promise, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Instrument info lookup timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

function createInstrumentInfoService({
  brokerage,
  clock = () => Date.now(),
  schedule = typeof setImmediate === 'function' ? setImmediate : (callback => setTimeout(callback, 0)),
  quoteTtlMs = DEFAULT_QUOTE_TTL_MS,
  metadataTtlMs = DEFAULT_METADATA_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onError
} = {}) {
  if (!brokerage || typeof brokerage.getAdapter !== 'function') {
    throw new Error('instrumentInfo requires brokerage.getAdapter');
  }

  const emitter = new EventEmitter();
  const cache = new Map();
  const quoteInflight = new Map();
  const metadataInflight = new Map();
  const metadataPrewarmers = new Map();

  function registerMetadataPrewarmer(name, callback) {
    const key = String(name || '').trim();
    if (!key || typeof callback !== 'function' || metadataPrewarmers.has(key)) return null;
    const entry = { callback, cancelled: false };
    metadataPrewarmers.set(key, entry);
    try {
      schedule(() => {
        if (entry.cancelled || metadataPrewarmers.get(key) !== entry) return;
        Promise.resolve()
          .then(() => callback({ brokerage }))
          .catch(err => {
            if (typeof onError === 'function') onError(err, { section: 'metadata-prewarm', name: key });
          });
      });
    } catch (err) {
      metadataPrewarmers.delete(key);
      if (typeof onError === 'function') onError(err, { section: 'metadata-prewarm', name: key });
      return null;
    }
    return () => {
      if (metadataPrewarmers.get(key) !== entry) return false;
      entry.cancelled = true;
      metadataPrewarmers.delete(key);
      return true;
    };
  }

  function resolveContext(context = {}) {
    const input = typeof context === 'string' ? { symbol: context } : (context || {});
    const symbol = normalizeSymbol(input.symbol || input.ticker || input.payload?.symbol || input.payload?.ticker);
    const resolution = brokerage.resolveProvider
      ? brokerage.resolveProvider({ ...input, symbol })
      : { provider: input.provider };
    const provider = normalizeProvider(input.provider || resolution?.provider);
    const instrumentType = String(input.instrumentType || input.payload?.instrumentType || (symbol ? detectInstrumentType(symbol) : '') || '').toUpperCase();
    return { provider, symbol, instrumentType };
  }

  function keyOf(resolved) {
    return `${resolved.provider}:${resolved.symbol}`;
  }

  function ensureRecord(resolved) {
    const key = keyOf(resolved);
    if (!cache.has(key)) {
      cache.set(key, {
        provider: resolved.provider,
        symbol: resolved.symbol,
        instrumentType: resolved.instrumentType,
        quote: {},
        metadata: {},
        sources: {},
        quoteUpdatedAt: null,
        metadataUpdatedAt: null
      });
    }
    const record = cache.get(key);
    if (!record.instrumentType && resolved.instrumentType) record.instrumentType = resolved.instrumentType;
    return record;
  }

  function emitUpdated(record, changed) {
    const snapshot = cloneSnapshot(record);
    emitter.emit('updated', snapshot, changed);
    return snapshot;
  }

  function mergeMetadata(record, raw, defaultSource, updatedAt = clock()) {
    const normalized = normalizeMetadata(raw);
    let changed = false;
    for (const [field, value] of Object.entries(normalized.metadata)) {
      if (record.metadata[field] !== value) changed = true;
      record.metadata[field] = value;
      const rawSource = normalized.sources[field];
      const source = rawSource && /^(?:adapter|config|explicit):/.test(String(rawSource))
        ? String(rawSource)
        : rawSource ? `${defaultSource}:${rawSource}` : defaultSource;
      if (source && record.sources[field] !== source) changed = true;
      if (source) record.sources[field] = source;
    }
    if (Object.keys(normalized.metadata).length) record.metadataUpdatedAt = updatedAt;
    return changed;
  }

  function ensureTickFallback(record) {
    if (positiveNumber(record.metadata.tickSize)) return false;
    const override = points.findTickSizeOverride(record.symbol);
    const tickSize = positiveNumber(override) || points.getDefaultTickSize();
    record.metadata.tickSize = tickSize;
    record.sources.tickSize = positiveNumber(override) ? 'config:tick-sizes' : 'config:defaultTickSize';
    record.metadataUpdatedAt = clock();
    return true;
  }

  async function loadQuote(resolved, adapter, options) {
    const key = keyOf(resolved);
    if (!quoteInflight.has(key)) {
      const task = Promise.resolve()
        .then(() => adapter.getQuote?.(resolved.symbol))
        .then(raw => {
          const record = ensureRecord(resolved);
          const quote = normalizeQuote(raw);
          let changed = false;
          if (Object.keys(quote).length) {
            changed = JSON.stringify(record.quote) !== JSON.stringify(quote);
            record.quote = { ...record.quote, ...quote };
            record.quoteUpdatedAt = clock();
          }
          changed = mergeMetadata(record, raw, `adapter:${resolved.provider}`) || changed;
          if (ensureTickFallback(record)) changed = true;
          if (changed) emitUpdated(record, { quote: Object.keys(quote).length > 0, metadata: true });
          return cloneSnapshot(record);
        })
        .catch(err => {
          if (typeof onError === 'function') onError(err, { ...resolved, section: 'quote' });
          const record = ensureRecord(resolved);
          if (ensureTickFallback(record)) emitUpdated(record, { quote: false, metadata: true });
          return cloneSnapshot(record);
        })
        .finally(() => quoteInflight.delete(key));
      quoteInflight.set(key, task);
    }
    return withTimeout(quoteInflight.get(key), options.timeoutMs);
  }

  async function loadMetadata(resolved, adapter, options) {
    const key = keyOf(resolved);
    if (!metadataInflight.has(key)) {
      const task = Promise.resolve()
        .then(() => adapter.getInstrumentMetadata?.(resolved.symbol))
        .then(raw => {
          const record = ensureRecord(resolved);
          const changed = mergeMetadata(record, raw, `adapter:${resolved.provider}`);
          const fallbackChanged = ensureTickFallback(record);
          if (changed || fallbackChanged) emitUpdated(record, { quote: false, metadata: true });
          return cloneSnapshot(record);
        })
        .catch(err => {
          if (typeof onError === 'function') onError(err, { ...resolved, section: 'metadata' });
          const record = ensureRecord(resolved);
          if (ensureTickFallback(record)) emitUpdated(record, { quote: false, metadata: true });
          return cloneSnapshot(record);
        })
        .finally(() => metadataInflight.delete(key));
      metadataInflight.set(key, task);
    }
    return withTimeout(metadataInflight.get(key), options.timeoutMs);
  }

  async function get(context, options = {}) {
    const resolved = resolveContext(context);
    if (!resolved.provider || !resolved.symbol) return null;
    const record = ensureRecord(resolved);
    const now = clock();
    const readQuote = options.quote !== false;
    const readMetadata = options.metadata !== false;
    const quoteAge = now - Number(record.quoteUpdatedAt || 0);
    const metadataAge = now - Number(record.metadataUpdatedAt || 0);
    const quoteMaxAge = Number.isFinite(Number(options.quoteMaxAgeMs)) ? Number(options.quoteMaxAgeMs) : quoteTtlMs;
    const metadataMaxAge = Number.isFinite(Number(options.metadataMaxAgeMs)) ? Number(options.metadataMaxAgeMs) : metadataTtlMs;
    const needsQuote = readQuote && (options.forceQuote === true || !record.quoteUpdatedAt || quoteAge >= quoteMaxAge);
    const needsMetadata = readMetadata && (options.forceMetadata === true || !record.metadataUpdatedAt || metadataAge >= metadataMaxAge);
    const adapter = brokerage.getAdapter(resolved.provider);
    const requestOptions = { timeoutMs: options.timeoutMs ?? timeoutMs };
    const tasks = [];
    if (needsMetadata && typeof adapter.getInstrumentMetadata === 'function') tasks.push(loadMetadata(resolved, adapter, requestOptions));
    if (needsQuote) tasks.push(loadQuote(resolved, adapter, requestOptions));
    if (tasks.length) {
      await Promise.all(tasks.map(task => Promise.resolve(task).catch(err => {
        if (typeof onError === 'function') onError(err, { ...resolved, section: 'lookup' });
        return null;
      })));
    }
    if (ensureTickFallback(record)) emitUpdated(record, { quote: false, metadata: true });
    return cloneSnapshot(record);
  }

  function peek(context) {
    const resolved = resolveContext(context);
    if (!resolved.provider || !resolved.symbol) return null;
    return cloneSnapshot(cache.get(keyOf(resolved)));
  }

  async function forget(context) {
    const resolved = resolveContext(context);
    if (!resolved.provider || !resolved.symbol) return false;
    const key = keyOf(resolved);
    const record = cache.get(key);
    if (record) {
      record.quote = {};
      record.quoteUpdatedAt = null;
    }
    try {
      const adapter = brokerage.getAdapter(resolved.provider);
      await adapter.forgetQuote?.(resolved.symbol);
    } catch (err) {
      if (typeof onError === 'function') onError(err, { ...resolved, section: 'forget' });
      return false;
    }
    return true;
  }

  function getTickSizeResolution(context, { explicitTickSize } = {}) {
    const explicit = positiveNumber(explicitTickSize);
    if (explicit) return { tickSize: explicit, source: 'explicit' };
    const snapshot = peek(context);
    const brokerTick = positiveNumber(snapshot?.metadata?.tickSize);
    const brokerSource = snapshot?.sources?.tickSize;
    if (brokerTick && String(brokerSource || '').startsWith('adapter:')) {
      return { tickSize: brokerTick, source: brokerSource };
    }
    const resolved = resolveContext(context);
    const override = positiveNumber(points.findTickSizeOverride(resolved.symbol));
    if (override) return { tickSize: override, source: 'config:tick-sizes' };
    if (brokerTick) return { tickSize: brokerTick, source: brokerSource || 'cache' };
    return { tickSize: points.getDefaultTickSize(), source: 'config:defaultTickSize' };
  }

  function resolveTickSize(context, options) {
    return getTickSizeResolution(context, options).tickSize;
  }

  function toPoints(context, deltaPrice, options = {}) {
    const resolved = resolveContext(context);
    const tickSize = resolveTickSize(resolved, options);
    return points.toPoints(
      tickSize,
      resolved.symbol,
      deltaPrice,
      options.priceHint,
      options.deltaTokenForFallback ?? deltaPrice
    );
  }

  function invalidateConfigTickSizes() {
    let count = 0;
    for (const record of cache.values()) {
      if (!String(record.sources?.tickSize || '').startsWith('config:')) continue;
      delete record.metadata.tickSize;
      delete record.sources.tickSize;
      record.metadataUpdatedAt = null;
      ensureTickFallback(record);
      emitUpdated(record, { quote: false, metadata: true });
      count += 1;
    }
    return count;
  }

  function on(eventName, handler) {
    emitter.on(eventName, handler);
    return () => emitter.off(eventName, handler);
  }

  return {
    get,
    peek,
    forget,
    resolveTickSize,
    getTickSizeResolution,
    toPoints,
    invalidateConfigTickSizes,
    registerMetadataPrewarmer,
    on,
    _cache: cache,
    _metadataPrewarmers: metadataPrewarmers
  };
}

module.exports = {
  createInstrumentInfoService,
  normalizeQuote,
  normalizeMetadata,
  DEFAULT_QUOTE_TTL_MS,
  DEFAULT_METADATA_TTL_MS,
  DEFAULT_TIMEOUT_MS
};
