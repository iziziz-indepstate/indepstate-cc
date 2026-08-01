const LEGACY_ROW_TYPES = Object.freeze(['levelOrder']);
const LEGACY_CHILD_STRATEGIES = Object.freeze(['limitBidTrade']);

function text(value) {
  return String(value || '').trim();
}

function hasLegacyRowType(row = {}) {
  return LEGACY_ROW_TYPES.includes(text(row.cardType));
}

function hasLevelOrderChildMeta(meta = {}) {
  return Boolean(meta.parentRequestId) || LEGACY_CHILD_STRATEGIES.includes(text(meta.strategy));
}

function legacyMetaFromEvent(rec = {}) {
  return rec.order?.meta || rec.origOrder?.meta || rec.payload?.meta || {};
}

function isLevelOrderChildPosition(position = {}) {
  const meta = position.source?.meta || position.executionIntent?.meta || position.card?.data?.meta || {};
  return hasLevelOrderChildMeta(meta);
}

function openingPolicyForLegacy(value = {}) {
  const meta = value.meta || {};
  if (!hasLegacyRowType(value) && !LEGACY_CHILD_STRATEGIES.includes(text(meta.strategy))) return null;
  return {
    kind: 'levelOrder',
    config: { strategy: meta.strategy || 'limitBidTrade' }
  };
}

function createLevelOrderLegacyGuard() {
  return {
    id: 'levelOrder',
    filteredRowTypes: [...LEGACY_ROW_TYPES],
    shouldFilterRow: hasLegacyRowType,
    shouldIgnoreLegacyExecutionEvent(rec = {}) {
      return hasLevelOrderChildMeta(legacyMetaFromEvent(rec)) || Boolean(rec.parentRequestId);
    },
    shouldIgnoreLegacyPositionEvent(rec = {}) {
      return hasLevelOrderChildMeta(legacyMetaFromEvent(rec)) || Boolean(rec.parentRequestId);
    },
    shouldHidePositionSnapshot: isLevelOrderChildPosition,
    shouldRemoveLegacyRowForPosition(_position, row) {
      return hasLegacyRowType(row);
    },
    openingPolicyForLegacy
  };
}

module.exports = {
  LEGACY_ROW_TYPES,
  LEGACY_CHILD_STRATEGIES,
  createLevelOrderLegacyGuard,
  hasLegacyRowType,
  isLevelOrderChildPosition,
  openingPolicyForLegacy
};
