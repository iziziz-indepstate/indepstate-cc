const LEGACY_ROW_TYPES = Object.freeze(['levelOrder']);
const LEGACY_CHILD_STRATEGIES = Object.freeze(['limitBidTrade']);

function text(value) {
  return String(value || '').trim();
}

function hasLegacyRowType(row = {}) {
  return LEGACY_ROW_TYPES.includes(text(row.cardType));
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
    openingPolicyForLegacy
  };
}

module.exports = {
  LEGACY_ROW_TYPES,
  LEGACY_CHILD_STRATEGIES,
  createLevelOrderLegacyGuard,
  hasLegacyRowType,
  openingPolicyForLegacy
};
