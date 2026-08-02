const PositionState = Object.freeze({
  DRAFT: 'draft',
  OPENING: 'opening',
  PLACED: 'placed',
  ACTIVE: 'active',
  CLOSING: 'closing',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  FAILED: 'failed',
  ARCHIVED: 'archived'
});

const PositionCommand = Object.freeze({
  CREATE: 'position.create',
  OPEN: 'position.open',
  CLOSE: 'position.close',
  REMOVE: 'position.remove',
  PROVIDER_PLACED: 'position.providerPlaced',
  PROVIDER_OPENED: 'position.providerOpened',
  PROVIDER_CLOSED: 'position.providerClosed',
  PROVIDER_CANCELLED: 'position.providerCancelled',
  PROVIDER_REJECTED: 'position.providerRejected',
  PROVIDER_FAILED: 'position.providerFailed',
  PNL_UPDATED: 'position.pnlUpdated'
});

const PositionEvent = Object.freeze({
  CREATED: 'position.created',
  OPEN_REQUESTED: 'position.openRequested',
  EXECUTION_REQUESTED: 'position.executionRequested',
  PENDING_OPEN_REQUESTED: 'position.pendingOpenRequested',
  PLACED: 'position.placed',
  OPENED: 'position.opened',
  CLOSE_REQUESTED: 'position.closeRequested',
  CLOSED: 'position.closed',
  CANCELLED: 'position.cancelled',
  REJECTED: 'position.rejected',
  FAILED: 'position.failed',
  REMOVED: 'position.removed',
  ARCHIVED: 'position.archived',
  PNL_UPDATED: 'position.pnlUpdated'
});

const IntegrationCommand = Object.freeze({
  PLACE_ORDER: 'execution.placeOrder',
  PLACE_PENDING_ORDER: 'execution.placePendingOrder',
  CLOSE_POSITION: 'execution.closePosition',
  CANCEL_ORDER: 'execution.cancelOrder'
});

module.exports = {
  PositionState,
  PositionCommand,
  PositionEvent,
  IntegrationCommand
};
