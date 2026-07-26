const { EventEmitter } = require('events');
const { normalizeTicker } = require('../levelOrder/command');

const DEFAULT_REFRESH_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;

function parseNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizeKey(value) {
  return String(value || '').trim();
}

function normalizeLevels(levels) {
  if (Array.isArray(levels)) {
    return levels
      .map(parseNumber)
      .filter(n => Number.isFinite(n) && n > 0);
  }
  return String(levels || '')
    .split(/[,\s;]+/)
    .map(parseNumber)
    .filter(n => Number.isFinite(n) && n > 0);
}

function normalizeGroup(group = {}) {
  const key = normalizeKey(group.key);
  return {
    key,
    enabled: group.enabled !== false,
    ticker: normalizeTicker(group.ticker || group.symbol),
    levels: normalizeLevels(group.levels),
    maxOffset: parseNumber(group.maxOffset)
  };
}

function normalizeConfig(config = {}) {
  const groups = Array.isArray(config.groups)
    ? config.groups.map(normalizeGroup).filter(group => group.key && group.ticker)
    : [];
  const refreshMsRaw = Number(config.refreshMs);
  const timeoutMsRaw = Number(config.timeoutMs);
  return {
    refreshMs: Number.isFinite(refreshMsRaw) && refreshMsRaw > 0 ? refreshMsRaw : DEFAULT_REFRESH_MS,
    timeoutMs: Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : DEFAULT_TIMEOUT_MS,
    groups
  };
}

function pickQuotePrice(quote = {}) {
  const price = parseNumber(quote.price);
  if (Number.isFinite(price)) return price;
  const bid = parseNumber(quote.bid);
  const ask = parseNumber(quote.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  if (Number.isFinite(bid)) return bid;
  if (Number.isFinite(ask)) return ask;
  return null;
}

function computeActiveLevel({ levels, maxOffset, price }) {
  const numericPrice = parseNumber(price);
  const numericOffset = parseNumber(maxOffset);
  const normalizedLevels = normalizeLevels(levels);
  if (!Number.isFinite(numericPrice)) {
    return { activeLevel: null, distance: null, reason: 'No quote price' };
  }
  if (!normalizedLevels.length) {
    return { activeLevel: null, distance: null, reason: 'No valid levels' };
  }
  if (!Number.isFinite(numericOffset) || numericOffset < 0) {
    return { activeLevel: null, distance: null, reason: 'Invalid max offset' };
  }
  let nearest = null;
  for (const level of normalizedLevels) {
    const distance = Math.abs(numericPrice - level);
    if (!nearest || distance < nearest.distance) nearest = { level, distance };
  }
  if (!nearest || nearest.distance > numericOffset) {
    return {
      activeLevel: null,
      distance: nearest ? nearest.distance : null,
      nearestLevel: nearest ? nearest.level : null,
      reason: 'No active level'
    };
  }
  return {
    activeLevel: nearest.level,
    distance: nearest.distance,
    nearestLevel: nearest.level,
    reason: null
  };
}

function createLevelTrackService({
  config = {},
  instrumentInfo,
  saveConfig,
  emitState,
  clock = () => Date.now()
} = {}) {
  const emitter = new EventEmitter();
  let cfg = normalizeConfig(config);
  const states = new Map();

  function snapshot() {
    return {
      config: {
        refreshMs: cfg.refreshMs,
        timeoutMs: cfg.timeoutMs,
        groups: cfg.groups.map(group => ({ ...group, levels: group.levels.slice() }))
      },
      states: cfg.groups.map(group => getState(group.key))
    };
  }

  function notify() {
    const data = snapshot();
    emitter.emit('state', data);
    if (typeof emitState === 'function') emitState(data);
    return data;
  }

  function configure(nextConfig = {}) {
    cfg = normalizeConfig(nextConfig);
    for (const key of Array.from(states.keys())) {
      if (!cfg.groups.some(group => group.key === key)) states.delete(key);
    }
    return notify();
  }

  function getGroup(key) {
    const normalized = normalizeKey(key);
    return cfg.groups.find(group => group.key === normalized) || null;
  }

  function getState(key) {
    const normalized = normalizeKey(key);
    const group = getGroup(normalized);
    const existing = states.get(normalized) || {};
    return {
      key: normalized,
      ticker: group?.ticker || existing.ticker || '',
      enabled: group?.enabled !== false,
      price: existing.price ?? null,
      provider: existing.provider || null,
      activeLevel: existing.activeLevel ?? null,
      nearestLevel: existing.nearestLevel ?? null,
      distance: existing.distance ?? null,
      status: existing.status || 'idle',
      reason: existing.reason || null,
      updatedAt: existing.updatedAt || null
    };
  }

  async function refreshGroup(key) {
    const group = getGroup(key);
    if (!group) {
      return { ok: false, error: `Unknown levelTrack group: ${key}` };
    }
    if (group.enabled === false) {
      const state = { key: group.key, ticker: group.ticker, enabled: false, status: 'disabled', reason: 'Group disabled', updatedAt: clock() };
      states.set(group.key, state);
      notify();
      return { ok: false, error: 'LevelTrack group is disabled', state };
    }
    if (!instrumentInfo || typeof instrumentInfo.get !== 'function') {
      return { ok: false, error: 'Instrument info service is not available' };
    }

    const snapshot = await instrumentInfo.get(
      { ticker: group.ticker, symbol: group.ticker },
      { forceQuote: true, timeoutMs: cfg.timeoutMs }
    );
    const price = pickQuotePrice(snapshot?.quote);
    const active = computeActiveLevel({ levels: group.levels, maxOffset: group.maxOffset, price });
    const ok = Number.isFinite(active.activeLevel);
    const state = {
      key: group.key,
      ticker: group.ticker,
      enabled: true,
      provider: snapshot?.provider || null,
      price,
      activeLevel: active.activeLevel,
      nearestLevel: active.nearestLevel ?? null,
      distance: active.distance,
      status: ok ? 'active' : 'inactive',
      reason: active.reason,
      updatedAt: clock()
    };
    states.set(group.key, state);
    notify();
    return ok ? { ok: true, level: active.activeLevel, state } : { ok: false, error: active.reason || 'No active level', state };
  }

  async function refreshAll() {
    const results = [];
    for (const group of cfg.groups) {
      try {
        results.push(await refreshGroup(group.key));
      } catch (err) {
        const state = {
          key: group.key,
          ticker: group.ticker,
          enabled: group.enabled !== false,
          status: 'error',
          reason: err?.message || String(err),
          updatedAt: clock()
        };
        states.set(group.key, state);
        results.push({ ok: false, error: state.reason, state });
        notify();
      }
    }
    return { ok: true, results, ...snapshot() };
  }

  async function save(nextConfig = {}) {
    const normalized = normalizeConfig(nextConfig);
    if (typeof saveConfig === 'function') {
      const result = await saveConfig(normalized);
      if (result?.config) configure(result.config);
      else configure(normalized);
      return result || { saved: true, config: normalized };
    }
    configure(normalized);
    return { saved: false, config: normalized };
  }

  async function resolveLevel({ key, ticker } = {}) {
    const group = getGroup(key);
    if (!group) return { ok: false, error: `Unknown levelTrack group: ${key}` };
    const normalizedTicker = normalizeTicker(ticker);
    if (normalizedTicker && group.ticker && normalizedTicker !== group.ticker) {
      return { ok: false, error: `LevelTrack group ${key} tracks ${group.ticker}, not ${normalizedTicker}` };
    }
    const result = await refreshGroup(group.key);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, level: result.level };
  }

  function on(eventName, handler) {
    emitter.on(eventName, handler);
    return () => emitter.off(eventName, handler);
  }

  return {
    configure,
    save,
    refreshAll,
    refreshGroup,
    resolveLevel,
    getGroup,
    getState,
    snapshot,
    on
  };
}

module.exports = {
  createLevelTrackService,
  computeActiveLevel,
  normalizeConfig,
  normalizeGroup,
  normalizeLevels,
  pickQuotePrice,
  DEFAULT_REFRESH_MS,
  DEFAULT_TIMEOUT_MS
};
