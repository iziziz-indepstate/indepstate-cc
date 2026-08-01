const { levelOrderChildCid } = require('./levelOrderRuntime');

function isLevelOrderChildOrder(order = {}) {
  const meta = order.meta || {};
  return Boolean(meta.parentRequestId) && String(meta.strategy || '') === 'limitBidTrade';
}

function createLevelOrderExecutionController({
  levelOrderPositionMonitors
} = {}) {
  const controller = {
    id: 'levelOrder',
    configureLifecycle(options = {}) {
      if (options.levelOrderPositionMonitors) {
        levelOrderPositionMonitors = options.levelOrderPositionMonitors;
      }
      return controller;
    },
    shouldTrackStandalonePosition(order = {}) {
      if (isLevelOrderChildOrder(order)) return false;
      return undefined;
    },
    onOrderConfirmed({ pendingId, ticket, rec } = {}) {
      const normalizedTicket = String(ticket || '');
      const parentRequestId = rec?.order?.meta?.parentRequestId;
      const monitor = parentRequestId ? levelOrderPositionMonitors?.get(parentRequestId) : null;
      if (!monitor || !normalizedTicket) return;
      const child = monitor.children?.find(item => {
        return item.requestId === rec.reqId || levelOrderChildCid(item) === String(pendingId);
      });
      if (child) child.providerOrderId = normalizedTicket;
    }
  };
  return controller;
}

module.exports = {
  createLevelOrderExecutionController,
  isLevelOrderChildOrder
};
