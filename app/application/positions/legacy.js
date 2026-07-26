const crypto = require('crypto');
const { PositionCommand } = require('../../domain/positions');

function hashId(prefix, value) {
  const text = JSON.stringify(value || {});
  return `${prefix}_${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function legacyRowToCreateCommand(row = {}) {
  const ticker = String(row.ticker || row.symbol || '').trim();
  const idSeed = row.positionId || row.requestId || row.producingLineId || row.time && `${ticker}:${row.event || ''}:${row.time}`;
  const cardType = row.cardType || (row.instrumentType === 'OPT' ? 'option' : 'regular');
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
      type: cardType === 'levelOrder' ? 'levelOrder' : cardType,
      actions: row.cardActions || row.actions
    },
    openingPolicy: openingPolicyForLegacy(row),
    source: row,
    executionIntent: row
  };
}

function legacyOrderPayloadToCreateCommand(payload = {}, resolvedProvider) {
  const meta = payload.meta || {};
  const ticker = String(payload.ticker || payload.symbol || '').trim();
  const requestId = meta.requestId || payload.requestId || payload.cid || meta.cid;
  return {
    type: PositionCommand.CREATE,
    positionId: requestId ? hashId('pos', requestId) : hashId('pos', payload),
    ticker,
    symbol: String(payload.symbol || ticker).trim(),
    instrumentType: payload.instrumentType || '',
    qty: payload.qty ?? meta.qty,
    provider: normalizeProvider(resolvedProvider || payload.provider || meta.provider),
    side: payload.side || payload.kind || payload.action || '',
    cardType: payload.cardType,
    card: {
      type: payload.cardType,
      actions: payload.cardActions || payload.actions
    },
    openingPolicy: openingPolicyForLegacy(payload),
    source: payload,
    executionIntent: payload
  };
}

function legacyOrderPayloadToOpenCommand(payload = {}, positionId) {
  return {
    type: PositionCommand.OPEN,
    positionId,
    payload,
    openingPolicy: openingPolicyForLegacy(payload)
  };
}

function openingPolicyForLegacy(value = {}) {
  const cardType = String(value.cardType || '').trim();
  if (cardType === 'levelOrder' || value.meta?.strategy === 'limitBidTrade') {
    return { kind: 'levelOrder', config: { strategy: value.meta?.strategy || 'limitBidTrade' } };
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
  legacyRowToCreateCommand,
  legacyOrderPayloadToCreateCommand,
  legacyOrderPayloadToOpenCommand,
  openingPolicyForLegacy,
  providerOpenedToCommand,
  providerClosedToCommand,
  providerCancelledToCommand
};
