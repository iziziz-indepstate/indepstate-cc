function text(value) {
  return String(value || '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function hasLegs(value = {}) {
  return array(value.legs).length > 0
    || array(value.order?.legs).length > 0
    || array(value.source?.legs).length > 0
    || array(value.executionIntent?.legs).length > 0
    || array(value.card?.data?.legs).length > 0;
}

function isOptionStratLike(value = {}) {
  const cardType = lower(value.cardType || value.card?.type);
  return value.instrumentType === 'OPT'
    || lower(value.event) === 'optionstrat'
    || lower(value.provider) === 'optionstrat'
    || cardType === 'option'
    || cardType === 'optionstrat'
    || hasLegs(value);
}

function isOptionStratLegacyRow(row = {}) {
  return isOptionStratLike(row);
}

function eventOrder(rec = {}) {
  return rec.order || rec.origOrder || rec.payload || rec.source || {};
}

function eventProvider(rec = {}) {
  return rec.provider || rec.order?.provider || rec.origOrder?.provider || rec.payload?.provider;
}

function isOptionStratExecutionEvent(rec = {}) {
  return isOptionStratLike({
    ...eventOrder(rec),
    provider: eventProvider(rec)
  });
}

function positionSources(position = {}) {
  return [
    position,
    position.source,
    position.executionIntent,
    position.card?.data
  ].filter(Boolean);
}

function isOptionStratPosition(position = {}) {
  return positionSources(position).some(isOptionStratLike);
}

function idsFrom(value = {}) {
  const meta = value.meta || {};
  return [
    value.requestId,
    value.cid,
    value.pendingId,
    value.positionId,
    value.producingLineId,
    meta.requestId,
    meta.cid,
    meta.pendingId,
    meta.positionId,
    meta.producingLineId
  ].map(text).filter(Boolean);
}

function ticketsFrom(value = {}) {
  return [
    value.ticket,
    value.providerOrderId,
    value.orderId,
    ...(Array.isArray(value.tickets) ? value.tickets : [])
  ].map(text).filter(Boolean);
}

function rowKeyParts(value = {}) {
  if (value.event == null && value.time == null && value.price == null) return '';
  return [
    value.ticker || value.symbol,
    value.event,
    value.time,
    value.price
  ].map(value => value == null ? '' : String(value)).join('|');
}

function positionIdSeedForLegacy(value = {}) {
  if (!isOptionStratLike(value)) return null;
  const explicit = text(value.positionId || value.sourcePositionId || value.meta?.positionId);
  if (explicit) return explicit;
  const ticker = text(value.ticker || value.symbol);
  const event = text(value.event);
  const time = text(value.time || value.sourceTime || value.meta?.sourceTime);
  if (ticker && event && time) return `${ticker}:${event}:${time}`;
  const sourceKey = text(value.sourceRowKey || value.meta?.sourceRowKey);
  if (sourceKey) return sourceKey;
  return null;
}

function legSignature(value = {}) {
  const legs = array(value.legs);
  if (!legs.length) return '';
  return legs.map(leg => [
    lower(leg.option || leg.type || leg.kind),
    lower(leg.side),
    text(leg.strike),
    text(leg.quantity ?? leg.qty)
  ].join(':')).join('|');
}

function fallbackSignature(value = {}) {
  return {
    ticker: lower(value.ticker || value.symbol),
    provider: lower(value.provider),
    name: lower(value.name || value.description),
    legs: legSignature(value)
  };
}

function signaturesMatch(positionValue = {}, row = {}) {
  const pos = fallbackSignature(positionValue);
  const legacy = fallbackSignature(row);
  if (!pos.ticker || !legacy.ticker || pos.ticker !== legacy.ticker) return false;
  if (pos.provider && legacy.provider && pos.provider !== legacy.provider) return false;
  if (pos.legs && legacy.legs) return pos.legs === legacy.legs;
  if (pos.name && legacy.name) return pos.name === legacy.name;
  return false;
}

function shouldRemoveLegacyRowForPosition(position = {}, row = {}) {
  if (!isOptionStratLegacyRow(row) || !isOptionStratPosition(position)) return false;

  const rowIds = new Set(idsFrom(row));
  for (const source of positionSources(position)) {
    if (idsFrom(source).some(id => rowIds.has(id))) return true;
  }

  const rowTickets = new Set(ticketsFrom(row));
  if (ticketsFrom(position).some(ticket => rowTickets.has(ticket))) return true;
  for (const source of positionSources(position)) {
    if (ticketsFrom(source).some(ticket => rowTickets.has(ticket))) return true;
  }

  const rowKey = rowKeyParts(row);
  for (const source of positionSources(position)) {
    if (rowKey && rowKeyParts(source) === rowKey) return true;
  }

  return positionSources(position).some(source => signaturesMatch(source, row));
}

function eventMatchesPosition(rec = {}, position = {}) {
  const order = eventOrder(rec);
  return shouldRemoveLegacyRowForPosition(position, order)
    || shouldRemoveLegacyRowForPosition(position, {
      ...order,
      provider: eventProvider(rec),
      ticket: rec.ticket || rec.providerOrderId,
      providerOrderId: rec.providerOrderId,
      requestId: rec.reqId || order.requestId || order.meta?.requestId
    });
}

function hasMatchingPositionSnapshot(rec = {}, context = {}) {
  const positions = Array.isArray(context.positions) ? context.positions : [];
  return positions.some(position => isOptionStratPosition(position) && eventMatchesPosition(rec, position));
}

function isDraftLikePosition(position = {}) {
  return ['draft', 'opening'].includes(lower(position.state || position.card?.data?.state));
}

function isErrorLikePosition(position = {}) {
  return ['rejected', 'failed', 'cancelled'].includes(lower(position.state || position.card?.data?.state));
}

function shouldLegacyRowOwnPosition(position = {}) {
  return isDraftLikePosition(position) || isErrorLikePosition(position);
}

function shouldSnapshotOwnLegacyRow(position = {}) {
  return ['placed', 'active', 'closing', 'closed'].includes(lower(position.state || position.card?.data?.state));
}

function hasMatchingLegacyRow(position = {}, context = {}) {
  const rows = Array.isArray(context.rows) ? context.rows : [];
  return rows.some(row => shouldRemoveLegacyRowForPosition(position, row));
}

function hasSnapshotOwnedMatchingPosition(row = {}, context = {}) {
  const positions = Array.isArray(context.positions) ? context.positions : [];
  return positions.some(position => (
    isOptionStratPosition(position)
      && shouldSnapshotOwnLegacyRow(position)
      && shouldRemoveLegacyRowForPosition(position, row)
  ));
}

function createOptionStratLegacyGuard() {
  return {
    id: 'optionstrat',
    positionIdSeedForLegacy,
    shouldRemoveLegacyRowForPosition(position = {}, row = {}) {
      if (!shouldSnapshotOwnLegacyRow(position)) return false;
      return shouldRemoveLegacyRowForPosition(position, row);
    },
    shouldResetLegacyRowForPosition(position = {}, row = {}) {
      return isErrorLikePosition(position) && shouldRemoveLegacyRowForPosition(position, row);
    },
    shouldRemovePositionSnapshotForLegacyRowRemoval(row = {}, position = {}) {
      return isOptionStratLegacyRow(row)
        && isOptionStratPosition(position)
        && shouldLegacyRowOwnPosition(position)
        && shouldRemoveLegacyRowForPosition(position, row);
    },
    shouldIgnoreLegacyRowForExistingPosition(row = {}, context = {}) {
      return isOptionStratLegacyRow(row) && hasSnapshotOwnedMatchingPosition(row, context);
    },
    shouldIgnoreLegacyExecutionEvent(rec = {}, context = {}) {
      return isOptionStratExecutionEvent(rec) && hasMatchingPositionSnapshot(rec, context);
    },
    shouldIgnoreLegacyPositionEvent(rec = {}, context = {}) {
      return isOptionStratExecutionEvent(rec) && hasMatchingPositionSnapshot(rec, context);
    },
    shouldHidePositionSnapshot(position = {}, context = {}) {
      return isOptionStratPosition(position)
        && shouldLegacyRowOwnPosition(position)
        && hasMatchingLegacyRow(position, context);
    }
  };
}

module.exports = {
  createOptionStratLegacyGuard,
  hasLegs,
  isOptionStratLegacyRow,
  isOptionStratPosition,
  positionIdSeedForLegacy,
  shouldRemoveLegacyRowForPosition
};
