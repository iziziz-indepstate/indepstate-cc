const { detectInstrumentType } = require('../instruments');
const { legacyRowToCreateCommand } = require('../../application/positions');
const { shouldRouteRowToLegacyRuntime } = require('./legacyRouting');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function rowIdentity(row = {}) {
  const producingLineId = row.producingLineId != null ? String(row.producingLineId) : '';
  if (producingLineId) return `line:${producingLineId}`;
  const ticker = String(row.ticker || row.symbol || '').trim().toUpperCase();
  const event = String(row.event || row.side || row.kind || '').trim().toLowerCase();
  const time = row.time != null ? String(row.time) : '';
  if (ticker || event || time) return `row:${ticker}:${event}:${time}`;
  return `json:${JSON.stringify(row)}`;
}

function matchesRemoveFilter(row = {}, filter = {}) {
  if (!filter || typeof filter !== 'object') return false;
  if (filter.producingLineId != null) {
    return String(row.producingLineId || '') === String(filter.producingLineId);
  }
  if (filter.positionId != null) {
    return String(row.positionId || '') === String(filter.positionId);
  }
  if (filter.ticker || filter.symbol) {
    const target = String(filter.ticker || filter.symbol || '').trim().toUpperCase();
    const current = String(row.ticker || row.symbol || '').trim().toUpperCase();
    return Boolean(target && current === target);
  }
  return false;
}

let nextServiceInstanceId = 0;

function createOrderCardsApplicationService({
  positions,
  resolveProviderName,
  detectInstrumentType: detectType = detectInstrumentType,
  getSourceServices,
  publish,
  legacyPublish
} = {}) {
  const readModel = new Map();
  nextServiceInstanceId += 1;
  const serviceInstanceId = nextServiceInstanceId;
  let nextEventSequence = 0;

  function createEventId() {
    nextEventSequence += 1;
    return `order-cards:${serviceInstanceId}:${nextEventSequence}`;
  }

  function normalizeRow(row = {}, context = {}) {
    const ticker = String(row.ticker || row.symbol || '').trim();
    const symbol = String(row.symbol || ticker).trim();
    const instrumentType = row.instrumentType || detectType(String(ticker || symbol || ''));
    const provider = typeof resolveProviderName === 'function'
      ? resolveProviderName({ row, symbol: ticker || symbol, instrumentType, source: context.source })
      : (row.provider || 'simulated');
    return {
      ...row,
      ticker: ticker || symbol,
      symbol,
      instrumentType,
      provider: String(provider || '').trim().toLowerCase()
    };
  }

  function publishUpdate(update) {
    publish?.('order-cards:changed', update);
    if (update?.type === 'upsert' && shouldRouteRowToLegacyRuntime(update.row)) {
      legacyPublish?.('orders:new', { ...update.row, __orderCardsEventId: update.eventId });
    }
    if (update?.type === 'remove') {
      legacyPublish?.('orders:remove', { ...update.filter, __orderCardsEventId: update.eventId });
    }
  }

  function ingestRow(row = {}, context = {}) {
    const normalized = normalizeRow(row, context);
    if (!shouldRouteRowToLegacyRuntime(normalized)) {
      if (typeof positions?.handle !== 'function') {
        const error = 'position snapshot handler is unavailable';
        console.warn('[positions] failed to record regular order card row:', error);
        return { ok: false, error };
      }
      try {
        const result = positions.handle(legacyRowToCreateCommand(normalized));
        if (result?.ok === false) {
          console.warn('[positions] failed to record regular order card row:', result.error || result.reason || 'unknown error');
          return { ok: false, error: result.error || result.reason || 'position snapshot creation failed' };
        }
      } catch (err) {
        console.warn('[positions] failed to record regular order card row:', err?.message || String(err));
        return { ok: false, error: err?.message || String(err) };
      }
    }
    readModel.set(rowIdentity(normalized), normalized);
    publishUpdate({
      type: 'upsert',
      row: clone(normalized),
      source: context.source,
      eventId: createEventId()
    });
    return clone(normalized);
  }

  function remove(filter = {}) {
    for (const [key, row] of Array.from(readModel.entries())) {
      if (matchesRemoveFilter(row, filter)) readModel.delete(key);
    }
    publishUpdate({ type: 'remove', filter: clone(filter), eventId: createEventId() });
    return { ok: true };
  }

  async function list({ rows = 100 } = {}) {
    const combined = Array.from(readModel.values());
    const services = typeof getSourceServices === 'function' ? getSourceServices() : [];
    for (const service of services || []) {
      if (typeof service?.getOrdersList !== 'function') continue;
      const sourceRows = await service.getOrdersList(rows);
      for (const row of sourceRows || []) combined.push(row);
    }
    const byKey = new Map();
    for (const row of combined) {
      const normalized = normalizeRow(row);
      byKey.set(rowIdentity(normalized), normalized);
    }
    return Array.from(byKey.values())
      .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0))
      .slice(0, Math.max(1, rows))
      .map(clone);
  }

  return {
    ingestRow,
    remove,
    list,
    normalizeRow
  };
}

module.exports = {
  createOrderCardsApplicationService,
  rowIdentity,
  matchesRemoveFilter
};
