const { EventEmitter } = require('events');

const DEFAULT_POLL_MS = 1000;
const DEFAULT_LOG_LIMIT = 200;

function finiteNumber(value) {
  if (value == null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function positiveLimit(value) {
  const number = finiteNumber(value);
  return number && number > 0 ? number : undefined;
}

function normalizeSymbol(value) {
  return String(value || '').trim();
}

function normalizeSymbolKey(value) {
  return normalizeSymbol(value).toUpperCase();
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSide(value) {
  const side = String(value || '').trim().toLowerCase();
  if (['buy', 'long', 'bot'].includes(side)) return 'buy';
  if (['sell', 'short', 'sld'].includes(side)) return 'sell';
  return '';
}

function normalizeConfig(config = {}) {
  const pollMs = finiteNumber(config.pollMs);
  const logLimit = finiteNumber(config.logLimit);
  const providers = {};
  for (const [rawName, rawProvider] of Object.entries(config.providers || {})) {
    const name = normalizeProvider(rawName);
    if (!name) continue;
    const provider = rawProvider || {};
    const symbols = {};
    for (const [rawSymbol, rawSymbolCfg] of Object.entries(provider.symbols || {})) {
      const symbol = normalizeSymbolKey(rawSymbol);
      if (!symbol) continue;
      const symbolCfg = rawSymbolCfg || {};
      symbols[symbol] = {
        enabled: symbolCfg.enabled !== false,
        maxStopRiskUsd: positiveLimit(symbolCfg.maxStopRiskUsd),
        maxOpenLossUsd: positiveLimit(symbolCfg.maxOpenLossUsd)
      };
    }
    providers[name] = {
      enabled: provider.enabled !== false,
      maxStopRiskUsd: positiveLimit(provider.maxStopRiskUsd),
      maxOpenLossUsd: positiveLimit(provider.maxOpenLossUsd),
      symbols
    };
  }
  return {
    enabled: config.enabled !== false,
    pollMs: pollMs && pollMs > 0 ? pollMs : DEFAULT_POLL_MS,
    logLimit: logLimit && logLimit > 0 ? Math.trunc(logLimit) : DEFAULT_LOG_LIMIT,
    providers
  };
}

function resolveLimits(config, provider, symbol) {
  const cfg = normalizeConfig(config);
  const providerCfg = cfg.providers[normalizeProvider(provider)];
  if (!cfg.enabled || !providerCfg || providerCfg.enabled === false) {
    return { enabled: false, maxStopRiskUsd: undefined, maxOpenLossUsd: undefined };
  }
  const symbolCfg = providerCfg.symbols[normalizeSymbolKey(symbol)] || {};
  if (symbolCfg.enabled === false) {
    return { enabled: false, maxStopRiskUsd: undefined, maxOpenLossUsd: undefined };
  }
  return {
    enabled: true,
    maxStopRiskUsd: symbolCfg.maxStopRiskUsd ?? providerCfg.maxStopRiskUsd,
    maxOpenLossUsd: symbolCfg.maxOpenLossUsd ?? providerCfg.maxOpenLossUsd
  };
}

function pickQuotePrice(quote = {}) {
  const price = finiteNumber(quote.price);
  if (price !== undefined) return price;
  const bid = finiteNumber(quote.bid);
  const ask = finiteNumber(quote.ask);
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
  if (bid !== undefined) return bid;
  if (ask !== undefined) return ask;
  return undefined;
}

function deriveStopLossPrice({ side, entryPrice, stopLossPrice, sl, stopPts, tickSize }) {
  const explicit = finiteNumber(stopLossPrice);
  if (explicit !== undefined && explicit > 0) return explicit;
  const entry = finiteNumber(entryPrice);
  const points = finiteNumber(sl ?? stopPts);
  const tick = finiteNumber(tickSize);
  const normalizedSide = normalizeSide(side);
  if (entry === undefined || points === undefined || tick === undefined || points <= 0 || tick <= 0 || !normalizedSide) return undefined;
  return normalizedSide === 'buy' ? entry - points * tick : entry + points * tick;
}

function calculateStopRiskUsd(snapshot = {}) {
  const qty = finiteNumber(snapshot.qty ?? snapshot.contracts ?? snapshot.size);
  const entryPrice = finiteNumber(snapshot.entryPrice ?? snapshot.openPrice ?? snapshot.price);
  const stopLossPrice = finiteNumber(snapshot.stopLossPrice);
  const contractSize = finiteNumber(snapshot.contractSize) ?? 1;
  if (qty === undefined || qty <= 0 || entryPrice === undefined || entryPrice <= 0 || stopLossPrice === undefined || stopLossPrice <= 0 || contractSize <= 0) {
    return undefined;
  }
  return Math.abs(entryPrice - stopLossPrice) * Math.abs(qty) * contractSize;
}

function calculateOpenLossUsd(snapshot = {}) {
  const pnl = finiteNumber(snapshot.unrealizedPnl ?? snapshot.pnl);
  if (pnl !== undefined) return pnl < 0 ? Math.abs(pnl) : 0;
  const qty = finiteNumber(snapshot.qty ?? snapshot.contracts ?? snapshot.size);
  const entryPrice = finiteNumber(snapshot.entryPrice ?? snapshot.openPrice);
  const currentPrice = finiteNumber(snapshot.currentPrice ?? snapshot.markPrice ?? snapshot.price);
  const contractSize = finiteNumber(snapshot.contractSize) ?? 1;
  const side = normalizeSide(snapshot.side);
  if (qty === undefined || qty <= 0 || entryPrice === undefined || currentPrice === undefined || contractSize <= 0 || !side) {
    return undefined;
  }
  const pnlEstimate = side === 'buy'
    ? (currentPrice - entryPrice) * Math.abs(qty) * contractSize
    : (entryPrice - currentPrice) * Math.abs(qty) * contractSize;
  return pnlEstimate < 0 ? Math.abs(pnlEstimate) : 0;
}

function positionKey(provider, ticket) {
  return `${normalizeProvider(provider)}:${String(ticket || '').trim()}`;
}

function checkLabel(check) {
  if (check === 'maxStopRiskUsd') return 'Stop size';
  if (check === 'maxOpenLossUsd') return 'Open loss';
  return check || '';
}

function actionForTracked(tracked = {}) {
  if (tracked.kind !== 'order') return 'close position';
  return String(tracked.ticket || '').startsWith('pending:')
    ? 'cancel pending'
    : 'cancel order';
}

function formatUsd(value) {
  const n = finiteNumber(value);
  return n === undefined ? '-' : `$${n.toFixed(2)}`;
}

function buildBreach({ tracked, check, value, limit }) {
  const label = checkLabel(check);
  const reason = `${label} ${formatUsd(value)} exceeds limit ${formatUsd(limit)}`;
  return {
    check,
    checkLabel: label,
    value,
    limit,
    action: actionForTracked(tracked),
    itemKind: tracked.kind || 'position',
    reason
  };
}

function isPendingOrderType(order = {}) {
  const type = String(order.type || order.orderType || '').toLowerCase();
  return type.includes('limit') || type.includes('stop') || type.includes('pending');
}

function createRiskManagerService({
  config = {},
  events,
  brokerage,
  instrumentInfo,
  saveConfig,
  emitState,
  clock = () => Date.now()
} = {}) {
  const emitter = new EventEmitter();
  let cfg = normalizeConfig(config);
  const positions = new Map();
  const logs = [];

  function appendLog(entry) {
    logs.unshift({ ts: clock(), ...entry });
    logs.splice(cfg.logLimit);
  }

  function notify() {
    const data = snapshot();
    emitter.emit('state', data);
    if (typeof emitState === 'function') emitState(data);
    return data;
  }

  function trackPosition(rec = {}) {
    const provider = normalizeProvider(rec.provider || rec.origOrder?.provider || rec.order?.provider);
    const ticket = String(rec.ticket || rec.order?.ticket || rec.order?.id || '').trim();
    if (!provider || !ticket) return null;
    const key = positionKey(provider, ticket);
    const existing = positions.get(key) || {};
    const order = rec.order || {};
    const origOrder = rec.origOrder || existing.origOrder || {};
    const symbol = normalizeSymbol(origOrder.symbol || origOrder.ticker || order.symbol || order.ticker || existing.symbol);
    const side = normalizeSide(origOrder.side || order.side || order.type || existing.side);
    const tracked = {
      ...existing,
      key,
      provider,
      ticket,
      symbol,
      side,
      origOrder,
      order,
      kind: 'position',
      status: 'open',
      openedAt: existing.openedAt || clock(),
      updatedAt: clock()
    };
    positions.set(key, tracked);
    notify();
    return tracked;
  }

  function trackOrder(rec = {}) {
    const result = rec.result || {};
    const order = rec.order || {};
    const status = String(result.status || '').toLowerCase();
    if (status === 'rejected') return null;
    if (status && !['ok', 'pending'].includes(status)) return null;
    if (!isPendingOrderType(order) && !String(result.providerOrderId || '').startsWith('pending:')) return null;
    const provider = normalizeProvider(result.provider || rec.provider || order.provider);
    const providerOrderId = String(result.providerOrderId || result.orderId || '').trim();
    const cid = String(result.cid || order.meta?.cid || '').trim();
    const ticket = providerOrderId || (cid ? `pending:${cid}` : '');
    if (!provider || !ticket) return null;
    const pendingId = ticket.startsWith('pending:') ? ticket.slice('pending:'.length) : cid;
    const key = positionKey(provider, ticket);
    const existing = positions.get(key) || {};
    const symbol = normalizeSymbol(order.symbol || order.ticker || existing.symbol);
    const side = normalizeSide(order.side || existing.side);
    const tracked = {
      ...existing,
      key,
      provider,
      ticket,
      pendingId,
      symbol,
      side,
      origOrder: order,
      order,
      kind: 'order',
      status: existing.status || 'pending',
      openedAt: existing.openedAt || clock(),
      updatedAt: clock()
    };
    positions.set(key, tracked);
    notify();
    return tracked;
  }

  function confirmOrder(rec = {}) {
    const provider = normalizeProvider(rec.provider || rec.order?.provider);
    const pendingId = String(rec.pendingId || rec.order?.meta?.cid || '').trim();
    const ticket = String(rec.ticket || '').trim();
    if (!provider || !ticket) return null;
    const oldKey = pendingId ? positionKey(provider, `pending:${pendingId}`) : '';
    const existing = oldKey ? positions.get(oldKey) : null;
    if (oldKey) positions.delete(oldKey);
    const order = rec.order || existing?.order || {};
    const key = positionKey(provider, ticket);
    const tracked = {
      ...(existing || {}),
      key,
      provider,
      ticket,
      pendingId,
      symbol: normalizeSymbol(order.symbol || order.ticker || existing?.symbol),
      side: normalizeSide(order.side || existing?.side),
      origOrder: order,
      order,
      kind: 'order',
      status: 'working',
      updatedAt: clock()
    };
    positions.set(key, tracked);
    notify();
    return tracked;
  }

  function untrackOrder(rec = {}) {
    const provider = normalizeProvider(rec.provider || rec.order?.provider);
    const pendingId = String(rec.pendingId || rec.order?.meta?.cid || '').trim();
    const ticket = String(rec.ticket || rec.providerOrderId || '').trim();
    const keys = [
      ticket ? positionKey(provider, ticket) : '',
      pendingId ? positionKey(provider, `pending:${pendingId}`) : ''
    ].filter(Boolean);
    let removed = false;
    for (const key of keys) removed = positions.delete(key) || removed;
    if (removed) notify();
  }

  function untrackPosition(rec = {}) {
    const key = positionKey(rec.provider, rec.ticket);
    if (positions.delete(key)) notify();
  }

  async function adapterFor(provider) {
    if (!brokerage || typeof brokerage.getAdapter !== 'function') return null;
    return brokerage.getAdapter(provider);
  }

  async function buildSnapshot(tracked) {
    const warnings = [];
    const adapter = await adapterFor(tracked.provider);
    let adapterSnapshot = null;
    if (adapter && typeof adapter.getRiskPositionSnapshot === 'function') {
      try {
        adapterSnapshot = await adapter.getRiskPositionSnapshot(tracked);
      } catch (err) {
        warnings.push(`Adapter snapshot failed: ${err?.message || String(err)}`);
      }
    }

    const orig = tracked.origOrder || {};
    const order = tracked.order || {};
    const merged = { ...orig, ...order, ...(adapterSnapshot || {}) };
    const symbol = normalizeSymbol(merged.symbol || merged.ticker || tracked.symbol);
    const side = normalizeSide(merged.side || tracked.side || order.type);
    let tickSize = finiteNumber(merged.tickSize);
    let contractSize = finiteNumber(merged.contractSize);

    if ((tickSize === undefined || contractSize === undefined) && instrumentInfo && typeof instrumentInfo.get === 'function' && symbol) {
      try {
        const info = await instrumentInfo.get(
          { provider: tracked.provider, symbol, ticker: symbol, instrumentType: merged.instrumentType || orig.instrumentType },
          { forceQuote: false }
        );
        if (tickSize === undefined) tickSize = finiteNumber(info?.tickSize ?? info?.quote?.tickSize);
        if (contractSize === undefined) contractSize = finiteNumber(info?.contractSize);
      } catch (err) {
        warnings.push(`Instrument metadata failed: ${err?.message || String(err)}`);
      }
    }

    let currentPrice = finiteNumber(merged.currentPrice ?? merged.markPrice);
    if (currentPrice === undefined && adapter && typeof adapter.getQuote === 'function' && symbol) {
      try {
        currentPrice = pickQuotePrice(await adapter.getQuote(symbol));
      } catch (err) {
        warnings.push(`Quote failed: ${err?.message || String(err)}`);
      }
    }

    const entryPrice = finiteNumber(merged.entryPrice ?? merged.openPrice ?? merged.open_price ?? orig.price ?? order.open_price);
    const qty = finiteNumber(merged.qty ?? merged.contracts ?? merged.size ?? merged.lots ?? merged.volume ?? orig.qty);
    const stopLossPrice = deriveStopLossPrice({
      side,
      entryPrice,
      stopLossPrice: merged.stopLossPrice ?? merged.slPrice ?? merged.stop_loss,
      sl: orig.sl ?? orig.stopPts ?? orig.meta?.stopPts,
      tickSize
    });
    const snapshot = {
      provider: tracked.provider,
      ticket: tracked.ticket,
      symbol,
      side,
      qty,
      entryPrice,
      stopLossPrice,
      unrealizedPnl: finiteNumber(merged.unrealizedPnl ?? merged.pnl ?? merged.profit),
      currentPrice,
      tickSize,
      contractSize: contractSize ?? 1,
      source: adapterSnapshot ? 'adapter' : 'tracked',
      warnings
    };

    if (!symbol) warnings.push('Missing symbol');
    if (!side) warnings.push('Missing side');
    if (qty === undefined || qty <= 0) warnings.push('Missing qty');
    if (entryPrice === undefined || entryPrice <= 0) warnings.push('Missing entry price');
    if (stopLossPrice === undefined || stopLossPrice <= 0) warnings.push('Missing stop loss price');

    snapshot.stopRiskUsd = calculateStopRiskUsd(snapshot);
    snapshot.openLossUsd = calculateOpenLossUsd(snapshot);
    if (tracked.kind !== 'order' && snapshot.openLossUsd === undefined) warnings.push('Missing current PnL');
    return snapshot;
  }

  async function closeTrackedPosition(tracked, reason, snapshotOverride) {
    if (!tracked || tracked.status === 'closing' || tracked.status === 'cancelling') return { status: 'skipped', reason: 'already closing' };
    const isOrder = tracked.kind === 'order';
    tracked.status = isOrder ? 'cancelling' : 'closing';
    tracked.closeReason = reason;
    tracked.updatedAt = clock();
    notify();
    const adapter = await adapterFor(tracked.provider);
    if (isOrder) {
      try {
        let result;
        if (tracked.pendingId && tracked.ticket === `pending:${tracked.pendingId}` && typeof adapter?.stopOpenOrder === 'function') {
          adapter.stopOpenOrder(tracked.pendingId, reason);
          result = { status: 'ok', provider: tracked.provider, raw: { pendingId: tracked.pendingId, action: 'stopOpenOrder' } };
        } else if (adapter && typeof adapter.cancelOrder === 'function') {
          result = await adapter.cancelOrder(tracked.ticket, tracked.symbol);
        } else {
          result = { status: 'unsupported', provider: tracked.provider, reason: 'Adapter cancelOrder is not supported' };
        }
        tracked.closeResult = result;
        tracked.status = result?.status === 'ok' || result?.status === 'simulated' ? 'cancelling' : 'cancel-failed';
        appendLog({ type: 'action', action: actionForTracked(tracked), itemKind: tracked.kind || 'order', provider: tracked.provider, ticket: tracked.ticket, symbol: tracked.symbol, reason, result });
        notify();
        return result;
      } catch (err) {
        const result = { status: 'error', provider: tracked.provider, reason: err?.message || String(err) };
        tracked.status = 'cancel-failed';
        tracked.closeResult = result;
        appendLog({ type: 'action-failed', action: actionForTracked(tracked), itemKind: tracked.kind || 'order', provider: tracked.provider, ticket: tracked.ticket, symbol: tracked.symbol, reason, result });
        notify();
        return result;
      }
    }

    if (!adapter || typeof adapter.closePosition !== 'function') {
      tracked.status = 'close-failed';
      const result = { status: 'unsupported', provider: tracked.provider, reason: 'Adapter closePosition is not supported' };
      appendLog({ type: 'action-failed', action: actionForTracked(tracked), itemKind: tracked.kind || 'position', provider: tracked.provider, ticket: tracked.ticket, symbol: tracked.symbol, reason, result });
      notify();
      return result;
    }
    try {
      const snapshotData = await buildSnapshot(tracked);
      tracked.snapshot = snapshotData || snapshotOverride || tracked.snapshot || null;
      const result = await adapter.closePosition({ ...tracked, snapshot: snapshotData }, reason);
      tracked.closeResult = result;
      tracked.status = result?.status === 'ok' || result?.status === 'simulated' ? 'closing' : 'close-failed';
      appendLog({ type: 'action', action: actionForTracked(tracked), itemKind: tracked.kind || 'position', provider: tracked.provider, ticket: tracked.ticket, symbol: tracked.symbol, reason, result });
      notify();
      return result;
    } catch (err) {
      const result = { status: 'error', provider: tracked.provider, reason: err?.message || String(err) };
      tracked.status = 'close-failed';
      tracked.closeResult = result;
      appendLog({ type: 'action-failed', action: actionForTracked(tracked), itemKind: tracked.kind || 'position', provider: tracked.provider, ticket: tracked.ticket, symbol: tracked.symbol, reason, result });
      notify();
      return result;
    }
  }

  async function refreshPosition(tracked) {
    const limits = resolveLimits(cfg, tracked.provider, tracked.symbol);
    const riskSnapshot = await buildSnapshot(tracked);
    tracked.snapshot = riskSnapshot;
    tracked.limits = limits;
    tracked.updatedAt = clock();

    if (!limits.enabled) {
      tracked.riskStatus = 'disabled';
      return { ok: true, tracked };
    }

    if (limits.maxStopRiskUsd !== undefined && riskSnapshot.stopRiskUsd !== undefined && riskSnapshot.stopRiskUsd > limits.maxStopRiskUsd) {
      const breach = buildBreach({ tracked, check: 'maxStopRiskUsd', value: riskSnapshot.stopRiskUsd, limit: limits.maxStopRiskUsd });
      const reason = breach.reason;
      tracked.riskStatus = 'breached';
      appendLog({ type: 'trigger', provider: tracked.provider, ticket: tracked.ticket, symbol: tracked.symbol, ...breach });
      await closeTrackedPosition(tracked, reason, riskSnapshot);
      return { ok: false, reason, tracked };
    }

    if (tracked.kind !== 'order' && limits.maxOpenLossUsd !== undefined && riskSnapshot.openLossUsd !== undefined && riskSnapshot.openLossUsd > limits.maxOpenLossUsd) {
      const breach = buildBreach({ tracked, check: 'maxOpenLossUsd', value: riskSnapshot.openLossUsd, limit: limits.maxOpenLossUsd });
      const reason = breach.reason;
      tracked.riskStatus = 'breached';
      appendLog({ type: 'trigger', provider: tracked.provider, ticket: tracked.ticket, symbol: tracked.symbol, ...breach });
      await closeTrackedPosition(tracked, reason, riskSnapshot);
      return { ok: false, reason, tracked };
    }

    tracked.riskStatus = riskSnapshot.warnings.length ? 'warning' : 'ok';
    return { ok: true, tracked };
  }

  async function refreshAll() {
    const results = [];
    for (const tracked of positions.values()) {
      if (tracked.status === 'closing' || tracked.status === 'cancelling') {
        results.push({ ok: true, skipped: true, tracked });
        continue;
      }
      try {
        results.push(await refreshPosition(tracked));
      } catch (err) {
        tracked.riskStatus = 'error';
        tracked.error = err?.message || String(err);
        tracked.updatedAt = clock();
        appendLog({ type: 'error', provider: tracked.provider, ticket: tracked.ticket, symbol: tracked.symbol, reason: tracked.error });
        results.push({ ok: false, error: tracked.error, tracked });
      }
    }
    notify();
    return { ok: true, results, ...snapshot() };
  }

  async function save(nextConfig = {}) {
    const normalized = normalizeConfig(nextConfig);
    if (typeof saveConfig === 'function') {
      const result = await saveConfig(normalized);
      configure(result?.config || normalized);
      return result || { saved: true, config: normalized };
    }
    configure(normalized);
    return { saved: false, config: normalized };
  }

  function configure(nextConfig = {}) {
    cfg = normalizeConfig(nextConfig);
    return notify();
  }

  function snapshot() {
    return {
      config: JSON.parse(JSON.stringify(cfg)),
      positions: Array.from(positions.values()).map(pos => ({
        key: pos.key,
        provider: pos.provider,
        ticket: pos.ticket,
        symbol: pos.symbol,
        side: pos.side,
        status: pos.status,
        kind: pos.kind || 'position',
        riskStatus: pos.riskStatus || 'pending',
        limits: pos.limits || resolveLimits(cfg, pos.provider, pos.symbol),
        snapshot: pos.snapshot || null,
        closeReason: pos.closeReason || null,
        closeResult: pos.closeResult || null,
        error: pos.error || null,
        openedAt: pos.openedAt,
        updatedAt: pos.updatedAt
      })),
      logs: logs.slice()
    };
  }

  function bindEvents() {
    if (!events || typeof events.on !== 'function') return;
    events.on('order:placed', trackOrder);
    events.on('order:confirmed', confirmOrder);
    events.on('order:rejected', untrackOrder);
    events.on('position:opened', trackPosition);
    events.on('position:closed', untrackPosition);
    events.on('order:cancelled', untrackPosition);
  }

  function on(eventName, handler) {
    emitter.on(eventName, handler);
    return () => emitter.off(eventName, handler);
  }

  return {
    configure,
    save,
    refreshAll,
    refreshPosition,
    closePosition: async (keyOrPosition, reason = 'manual close') => {
      const tracked = typeof keyOrPosition === 'string'
        ? positions.get(keyOrPosition)
        : positions.get(positionKey(keyOrPosition?.provider, keyOrPosition?.ticket));
      if (!tracked) return { status: 'error', reason: 'Position is not tracked' };
      return closeTrackedPosition(tracked, reason);
    },
    trackPosition,
    trackOrder,
    confirmOrder,
    untrackPosition,
    untrackOrder,
    snapshot,
    bindEvents,
    on
  };
}

module.exports = {
  createRiskManagerService,
  normalizeConfig,
  resolveLimits,
  calculateStopRiskUsd,
  calculateOpenLossUsd,
  deriveStopLossPrice,
  normalizeSide,
  DEFAULT_POLL_MS,
  DEFAULT_LOG_LIMIT
};
