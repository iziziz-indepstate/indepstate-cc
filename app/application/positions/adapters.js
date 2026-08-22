const crypto = require('crypto');
const { PositionCommand } = require('../../domain/positions');

const positionInputAdapters = [];

function hashId(prefix, value) {
  const text = JSON.stringify(value || {});
  return `${prefix}_${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function positionIdSeedForInput(value = {}, context = {}) {
  for (const adapter of positionInputAdapters) {
    const seed = adapter.positionIdSeedForInput?.(value, context);
    if (seed) return seed;
  }
  return null;
}

function cardTypeForInput(value = {}, fallback, context = {}) {
  for (const adapter of positionInputAdapters) {
    const cardType = adapter.cardTypeForInput?.(value, context);
    if (cardType) return cardType;
  }
  return fallback;
}

function registerPositionInputAdapter(adapter = {}) {
  if (!adapter || typeof adapter !== 'object') return false;
  positionInputAdapters.push(adapter);
  return () => {
    const idx = positionInputAdapters.indexOf(adapter);
    if (idx >= 0) positionInputAdapters.splice(idx, 1);
  };
}

function rowToCreatePositionCommand(row = {}, context = {}) {
  const ticker = String(row.ticker || row.symbol || '').trim();
  const idSeed = positionIdSeedForInput(row, context) || row.positionId || row.requestId || row.producingLineId || row.time && `${ticker}:${row.event || ''}:${row.time}`;
  const cardType = row.cardType || cardTypeForInput(row, 'regular', context);
  return {
    type: PositionCommand.CREATE,
    positionId: idSeed ? hashId('pos', idSeed) : hashId('pos', row),
    ticker,
    symbol: String(row.symbol || ticker).trim(),
    instrumentType: row.instrumentType || '',
    qty: row.qty,
    provider: normalizeProvider(row.provider),
    side: row.side || row.kind || '',
    cardType,
    card: {
      type: cardType,
      actions: row.cardActions || row.actions
    },
    openingPolicy: openingPolicyForInput(row, context),
    source: row,
    executionIntent: row
  };
}

function orderPayloadToCreatePositionCommand(payload = {}, resolvedProvider) {
  const meta = payload.meta || {};
  const ticker = String(payload.ticker || payload.symbol || '').trim();
  const requestId = meta.requestId || payload.requestId || payload.cid || meta.cid;
  const explicitPositionId = payload.positionId || payload.sourcePositionId || meta.positionId;
  const idSeed = positionIdSeedForInput({ ...payload, provider: resolvedProvider || payload.provider || meta.provider });
  const cardType = payload.cardType || cardTypeForInput({ ...payload, provider: resolvedProvider || payload.provider || meta.provider }, undefined);
  return {
    type: PositionCommand.CREATE,
    positionId: explicitPositionId || (idSeed ? hashId('pos', idSeed) : requestId ? hashId('pos', requestId) : hashId('pos', payload)),
    ticker,
    symbol: String(payload.symbol || ticker).trim(),
    instrumentType: payload.instrumentType || '',
    qty: payload.qty ?? meta.qty,
    provider: normalizeProvider(resolvedProvider || payload.provider || meta.provider),
    side: payload.side || payload.kind || payload.action || '',
    cardType,
    card: {
      type: cardType,
      actions: payload.cardActions || payload.actions
    },
    openingPolicy: openingPolicyForInput(payload),
    source: payload,
    executionIntent: payload
  };
}

function orderPayloadToOpenPositionCommand(payload = {}, positionId) {
  return {
    type: PositionCommand.OPEN,
    positionId,
    payload,
    openingPolicy: openingPolicyForInput(payload)
  };
}

function openingPolicyForInput(value = {}, context = {}) {
  for (const adapter of positionInputAdapters) {
    const policy = adapter.openingPolicyForInput?.(value, context);
    if (policy) return policy;
  }
  const strategy = value.strategy || value.meta?.strategy;
  if (strategy && ['consolidation', 'falseBreak', 'limitByCurrent'].includes(String(strategy))) {
    return { kind: 'pending', config: { strategy } };
  }
  return { kind: 'regular' };
}

function providerOpenedToCommand(event = {}, positionId) {
  return {
    type: PositionCommand.PROVIDER_OPENED,
    positionId,
    ticket: event.ticket,
    provider: event.provider,
    payload: event.order,
    origOrder: event.origOrder,
    requestId: event.origOrder?.meta?.requestId
  };
}

function providerClosedToCommand(event = {}, positionId) {
  return {
    type: PositionCommand.PROVIDER_CLOSED,
    positionId,
    ticket: event.ticket,
    provider: event.provider,
    trade: event.trade,
    profit: event.profit,
    final: true
  };
}

function providerCancelledToCommand(event = {}, positionId) {
  return {
    type: PositionCommand.PROVIDER_CANCELLED,
    positionId,
    ticket: event.ticket,
    provider: event.provider
  };
}

module.exports = {
  registerPositionInputAdapter,
  positionIdSeedForInput,
  cardTypeForInput,
  rowToCreatePositionCommand,
  orderPayloadToCreatePositionCommand,
  orderPayloadToOpenPositionCommand,
  openingPolicyForInput,
  providerOpenedToCommand,
  providerClosedToCommand,
  providerCancelledToCommand
};
