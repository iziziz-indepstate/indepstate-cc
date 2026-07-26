const { PositionState } = require('./types');

const DEFAULT_REGULAR_ACTIONS = Object.freeze([
  { id: 'BL', label: 'BL', command: 'position.open', style: 'bl' },
  { id: 'BC', label: 'BC', command: 'position.openPending', style: 'bc' },
  { id: 'BFB', label: 'BFB', command: 'position.openPending', style: 'bc' },
  { id: 'SL', label: 'SL', command: 'position.open', style: 'sl' },
  { id: 'SC', label: 'SC', command: 'position.openPending', style: 'sc' },
  { id: 'SFB', label: 'SFB', command: 'position.openPending', style: 'sc' }
]);

const LEVEL_ORDER_ACTIONS = Object.freeze([
  { id: 'LB', label: 'LB', command: 'position.levelOrder.buy', style: 'bl' },
  { id: 'LS', label: 'LS', command: 'position.levelOrder.sell', style: 'sl' }
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeAction(action = {}) {
  if (typeof action === 'string') {
    return { id: action, label: action, command: 'position.open' };
  }
  const id = String(action.id || action.action || action.label || '').trim();
  if (!id) return null;
  return {
    id,
    label: String(action.label || id),
    command: action.command || action.commandType || 'position.open',
    style: action.style,
    payload: clone(action.payload)
  };
}

function normalizeActions(actions) {
  return (actions || []).map(normalizeAction).filter(Boolean);
}

function isActionableState(state) {
  return [
    PositionState.DRAFT,
    PositionState.REJECTED,
    PositionState.CANCELLED,
    PositionState.FAILED
  ].includes(state);
}

function lifecycleActions(position = {}) {
  if ([PositionState.PLACED, PositionState.ACTIVE].includes(position.state)) {
    return [{ id: 'close', label: 'Close', command: 'position.close', style: 'close' }];
  }
  if (position.state === PositionState.CLOSED) {
    return [{ id: 'archive', label: 'Archive', command: 'position.remove', style: 'archive' }];
  }
  return [];
}

function pick(source = {}, keys = []) {
  const data = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') data[key] = value;
  }
  return data;
}

function derivePositionCard(position = {}, opts = {}) {
  const source = position.source || {};
  const policyKind = String(position.openingPolicy?.kind || '');
  const explicit = opts.card || position.cardSpec || {};
  const type = explicit.type || source.cardType || (policyKind === 'levelOrder' ? 'levelOrder' : 'regular');
  const baseData = {
    ticker: position.ticker || position.symbol || source.ticker || source.symbol,
    symbol: position.symbol || source.symbol || source.ticker,
    provider: position.provider || source.provider,
    state: position.state,
    pnl: position.pnlSnapshot || { status: 'unavailable' },
    timestamps: position.timestamps || {}
  };

  if (type === 'levelOrder') {
    const data = {
      ...baseData,
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
    };
    return {
      type: 'levelOrder',
      actions: isActionableState(position.state) ? clone(LEVEL_ORDER_ACTIONS) : lifecycleActions(position),
      data
    };
  }

  const sourceActions = source.cardActions || source.actions || explicit.actions || opts.defaultActions;
  const actions = isActionableState(position.state)
    ? normalizeActions(sourceActions).length
      ? normalizeActions(sourceActions)
      : clone(DEFAULT_REGULAR_ACTIONS)
    : lifecycleActions(position);
  return {
    type,
    actions,
    data: {
      ...baseData,
      ...pick(source, ['price', 'qty', 'sl', 'tp', 'risk', 'riskUsd', 'event', 'instrumentType'])
    }
  };
}

module.exports = {
  DEFAULT_REGULAR_ACTIONS,
  LEVEL_ORDER_ACTIONS,
  derivePositionCard
};
