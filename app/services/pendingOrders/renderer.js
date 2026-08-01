const PENDING_ACTIONS = Object.freeze({
  BC: { strategy: 'consolidation', side: 'long' },
  SC: { strategy: 'consolidation', side: 'short' },
  BFB: { strategy: 'falseBreak', side: 'long' },
  SFB: { strategy: 'falseBreak', side: 'short' },
  BP: { strategy: 'limitByCurrent', side: 'long' },
  SP: { strategy: 'limitByCurrent', side: 'short' }
});

function createPendingOrdersRenderer() {
  function actionInfo(action) {
    return PENDING_ACTIONS[action] || null;
  }

  return {
    PENDING_ACTIONS,
    actionInfo
  };
}

module.exports = {
  PENDING_ACTIONS,
  createPendingOrdersRenderer
};
