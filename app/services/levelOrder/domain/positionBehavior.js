const { PositionState, PositionEvent } = require('../../../domain/positions/types');
const {
  isActionableState,
  lifecycleActions,
  pick
} = require('../../../domain/positions/cardMetadata');

const LEVEL_ORDER_ACTIONS = Object.freeze([
  { id: 'LB', label: 'LB', command: 'position.levelOrder.buy', style: 'bl' },
  { id: 'LS', label: 'LS', command: 'position.levelOrder.sell', style: 'sl' }
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isLevelOrderPosition(position = {}) {
  return position.openingPolicy?.kind === 'levelOrder'
    || position.cardSpec?.type === 'levelOrder'
    || position.card?.type === 'levelOrder'
    || position.source?.cardType === 'levelOrder';
}

function childKey(command = {}) {
  return String(command.childRequestId || command.requestId || command.pendingId || command.cid || command.ticket || command.providerOrderId || '').trim();
}

function normalizeChild(command = {}, state, normalizeTicket) {
  const ticket = normalizeTicket(command.ticket || command.providerOrderId);
  const requestId = String(command.requestId || command.childRequestId || command.payload?.meta?.requestId || command.origOrder?.meta?.requestId || '').trim();
  const parentRequestId = String(command.parentRequestId || command.payload?.meta?.parentRequestId || command.origOrder?.meta?.parentRequestId || '').trim();
  const pendingId = String(command.pendingId || command.cid || command.payload?.meta?.cid || '').trim();
  const childIndex = command.childIndex ?? command.payload?.meta?.childIndex ?? command.origOrder?.meta?.childIndex;
  const childCount = command.childCount ?? command.payload?.meta?.childCount ?? command.origOrder?.meta?.childCount;
  return {
    requestId,
    parentRequestId,
    childIndex: Number.isFinite(Number(childIndex)) ? Number(childIndex) : undefined,
    childCount: Number.isFinite(Number(childCount)) ? Number(childCount) : undefined,
    state,
    ticket: ticket || undefined,
    providerOrderId: normalizeTicket(command.providerOrderId) || ticket || undefined,
    pendingId: pendingId || undefined,
    cid: pendingId || undefined,
    provider: command.provider || undefined,
    payload: clone(command.payload || command.order || command.origOrder) || undefined,
    reason: command.reason || undefined
  };
}

function cleanChild(child = {}) {
  const out = {};
  for (const [key, value] of Object.entries(child)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

function childMatches(child = {}, command = {}) {
  const ids = [
    command.requestId,
    command.childRequestId,
    command.pendingId,
    command.cid,
    command.ticket,
    command.providerOrderId
  ].map(value => String(value || '').trim()).filter(Boolean);
  return ids.some(id => [
    child.requestId,
    child.childRequestId,
    child.pendingId,
    child.cid,
    child.ticket,
    child.providerOrderId
  ].map(value => String(value || '').trim()).includes(id));
}

function findChildKey(position, command = {}) {
  for (const [key, child] of position.children.entries()) {
    if (childMatches(child, command)) return key;
  }
  return '';
}

function upsertChild(position, command = {}, state, ctx) {
  const childCount = command.childCount ?? command.payload?.meta?.childCount ?? command.origOrder?.meta?.childCount;
  if (Number.isFinite(Number(childCount)) && Number(childCount) > position.expectedChildren) {
    position.expectedChildren = Number(childCount);
  }
  const key = childKey(command) || findChildKey(position, command);
  if (!key) return null;
  const prevKey = findChildKey(position, command);
  const prev = position.children.get(key) || position.children.get(prevKey) || {};
  const next = cleanChild({ ...prev, ...normalizeChild(command, state, ctx.normalizeTicket), state });
  if (prevKey && prevKey !== key) position.children.delete(prevKey);
  position.children.set(key, next);
  const ticket = ctx.normalizeTicket(next.ticket || next.providerOrderId);
  if (ticket) {
    position.primaryTicket = position.primaryTicket || ticket;
    position.tickets.add(ticket);
  }
  return next;
}

function expectedChildren(position) {
  return Math.max(Number(position.expectedChildren) || 0, position.children.size || 0);
}

function activeChildren(position) {
  return Array.from(position.children.values()).filter(child => [PositionState.ACTIVE, PositionState.CLOSING, PositionState.CLOSED].includes(child.state));
}

function closedChildren(position) {
  return Array.from(position.children.values()).filter(child => child.state === PositionState.CLOSED);
}

function resetDraft(position, reason = '') {
  position.state = PositionState.DRAFT;
  position.primaryTicket = '';
  position.tickets.clear();
  position.children.clear();
  position.expectedChildren = 0;
  position.pnlSnapshot = { status: 'unavailable' };
  position.timestamps.openingAt = null;
  position.timestamps.placedAt = null;
  position.timestamps.openedAt = null;
  position.timestamps.closingAt = null;
  position.timestamps.closedAt = null;
  position.lastReason = reason;
}

function aggregatePnl(position, command = {}, ctx) {
  const currentTicket = ctx.normalizeTicket(command.ticket || command.providerOrderId);
  const raw = ctx.normalizePnlSnapshot(command);
  const previous = position.pnlSnapshot && position.pnlSnapshot.children ? clone(position.pnlSnapshot.children) : {};
  if (currentTicket && raw.status === 'reported') previous[currentTicket] = raw.value;
  const values = Object.values(previous).map(Number).filter(Number.isFinite);
  if (values.length) {
    return {
      status: values.length >= closedChildren(position).length ? 'reported' : 'partial',
      value: values.reduce((sum, value) => sum + value, 0),
      source: 'provider',
      children: previous,
      raw: clone(command.trade) || null
    };
  }
  return raw;
}

function baseData(position = {}) {
  const source = position.source || {};
  return {
    ticker: position.ticker || position.symbol || source.ticker || source.symbol,
    symbol: position.symbol || source.symbol || source.ticker,
    provider: position.provider || source.provider,
    state: position.state,
    pnl: position.pnlSnapshot || { status: 'unavailable' },
    timestamps: position.timestamps || {}
  };
}

function deriveLevelOrderCard(position = {}) {
  const source = position.source || {};
  return {
    type: 'levelOrder',
    actions: isActionableState(position.state) ? clone(LEVEL_ORDER_ACTIONS) : lifecycleActions(position),
    data: {
      ...baseData(position),
      children: clone(position.children) || [],
      expectedChildren: position.expectedChildren,
      tickets: clone(position.tickets) || [],
      ...pick(source, [
        'level',
        'risk',
        'riskUsd',
        'stopOffsetPts',
        'maxLot',
        'minLot',
        'takeProfitPts',
        'pointSize',
        'buyPriceSource',
        'sellPriceSource'
      ])
    }
  };
}

function createLevelOrderPositionBehavior() {
  return {
    id: 'levelOrder',
    matches: isLevelOrderPosition,
    deriveCard: deriveLevelOrderCard,
    providerPlaced(position, command, ctx) {
      const ticket = ctx.normalizeTicket(command.ticket || command.providerOrderId);
      if (ticket && position.tickets.has(ticket) && [PositionState.PLACED, PositionState.ACTIVE, PositionState.CLOSING, PositionState.CLOSED].includes(position.state)) {
        return { events: [], integrationCommands: [] };
      }
      upsertChild(position, command, PositionState.PLACED, ctx);
      if (![PositionState.ACTIVE, PositionState.CLOSING, PositionState.CLOSED].includes(position.state)) {
        position.state = PositionState.PLACED;
        position.timestamps.placedAt = position.timestamps.placedAt || ctx.now(command);
      }
      ctx.touch();
      return { events: [ctx.event(PositionEvent.PLACED, { ticket, timestamp: position.timestamps.placedAt })], integrationCommands: [] };
    },
    providerOpened(position, command, ctx) {
      const ticket = ctx.normalizeTicket(command.ticket || command.providerOrderId);
      if (ticket) {
        position.primaryTicket = position.primaryTicket || ticket;
        position.tickets.add(ticket);
      }
      upsertChild(position, command, PositionState.ACTIVE, ctx);
      if (activeChildren(position).length >= expectedChildren(position)) {
        position.state = PositionState.ACTIVE;
        position.timestamps.openedAt = position.timestamps.openedAt || ctx.now(command);
      } else if (![PositionState.CLOSING, PositionState.CLOSED].includes(position.state)) {
        position.state = PositionState.PLACED;
      }
      ctx.touch();
      return { events: [ctx.event(PositionEvent.OPENED, { ticket, timestamp: position.timestamps.openedAt })], integrationCommands: [] };
    },
    providerClosed(position, command, ctx) {
      const ticket = ctx.normalizeTicket(command.ticket || command.providerOrderId);
      const hadActiveChildren = activeChildren(position).length > 0 || [PositionState.ACTIVE, PositionState.CLOSED].includes(position.state);
      upsertChild(position, command, PositionState.CLOSED, ctx);
      if (!hadActiveChildren) {
        resetDraft(position, command.reason || command.trade?.reason || command.trade?.pnlStatus || 'Closed before open');
        ctx.touch();
        return { events: [ctx.event(PositionEvent.CANCELLED, { ticket, timestamp: ctx.now(command) })], integrationCommands: [] };
      }
      if (command.pnlSnapshot || command.profit != null || command.trade) {
        position.pnlSnapshot = aggregatePnl(position, command, ctx);
      }
      const allChildrenClosed = position.children.size > 0
        && position.expectedChildren > 0
        && closedChildren(position).length >= Math.min(position.expectedChildren, activeChildren(position).length || position.expectedChildren);
      if (position.children.size === 0 || allChildrenClosed || command.final !== false) {
        position.state = PositionState.CLOSED;
        position.timestamps.closedAt = position.timestamps.closedAt || ctx.now(command);
      }
      ctx.touch();
      return { events: [ctx.event(PositionEvent.CLOSED, { ticket, pnlSnapshot: clone(position.pnlSnapshot), timestamp: position.timestamps.closedAt })], integrationCommands: [] };
    },
    providerCancelled(position, command, ctx) {
      const ticket = ctx.normalizeTicket(command.ticket || command.providerOrderId);
      if (ticket) position.tickets.delete(ticket);
      upsertChild(position, command, PositionState.CANCELLED, ctx);
      if (activeChildren(position).length === 0) resetDraft(position, command.reason || 'Cancelled before open');
      ctx.touch();
      return { events: [ctx.event(PositionEvent.CANCELLED, { ticket, timestamp: ctx.now(command) })], integrationCommands: [] };
    },
    providerRejected(position, command, ctx) {
      upsertChild(position, command, PositionState.REJECTED, ctx);
      if (activeChildren(position).length === 0) resetDraft(position, command.reason || 'Rejected before open');
      position.lastReason = command.reason || '';
      ctx.touch();
      return { events: [ctx.event(PositionEvent.REJECTED, { reason: position.lastReason, timestamp: ctx.now(command) })], integrationCommands: [] };
    },
    providerFailed(position, command, ctx) {
      upsertChild(position, command, PositionState.FAILED, ctx);
      if (activeChildren(position).length === 0) resetDraft(position, command.reason || 'Failed before open');
      position.lastReason = command.reason || '';
      ctx.touch();
      return { events: [ctx.event(PositionEvent.FAILED, { reason: position.lastReason, timestamp: ctx.now(command) })], integrationCommands: [] };
    }
  };
}

module.exports = {
  LEVEL_ORDER_ACTIONS,
  isLevelOrderPosition,
  normalizeChild,
  childMatches,
  childKey,
  activeChildren,
  closedChildren,
  resetDraft,
  aggregatePnl,
  deriveLevelOrderCard,
  createLevelOrderPositionBehavior
};
