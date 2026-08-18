const LEVEL_ORDER_ROW_TYPES = Object.freeze(['levelOrder']);
const LEVEL_ORDER_CHILD_STRATEGIES = Object.freeze(['limitBidTrade']);

function text(value) {
  return String(value || '').trim();
}

function hasLevelOrderRowType(row = {}) {
  return LEVEL_ORDER_ROW_TYPES.includes(text(row.cardType));
}

function openingPolicyForInput(value = {}) {
  const meta = value.meta || {};
  if (!hasLevelOrderRowType(value) && !LEVEL_ORDER_CHILD_STRATEGIES.includes(text(meta.strategy))) return null;
  return {
    kind: 'levelOrder',
    config: { strategy: meta.strategy || 'limitBidTrade' }
  };
}

function createLevelOrderPositionInputAdapter() {
  return {
    id: 'levelOrder',
    openingPolicyForInput
  };
}

module.exports = {
  LEVEL_ORDER_ROW_TYPES,
  LEVEL_ORDER_CHILD_STRATEGIES,
  createLevelOrderPositionInputAdapter,
  hasLevelOrderRowType,
  openingPolicyForInput
};
