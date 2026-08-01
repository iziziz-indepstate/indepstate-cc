function isLevelOrderChildOrder(order = {}) {
  const meta = order.meta || {};
  return Boolean(meta.parentRequestId) && String(meta.strategy || '') === 'limitBidTrade';
}

function createLevelOrderExecutionController() {
  return {
    id: 'levelOrder',
    shouldTrackStandalonePosition(order = {}) {
      if (isLevelOrderChildOrder(order)) return false;
      return undefined;
    }
  };
}

module.exports = {
  createLevelOrderExecutionController,
  isLevelOrderChildOrder
};
