const { PositionState } = require('../../../domain/positions/types');
const {
  isActionableState,
  lifecycleActions,
  pick
} = require('../../../domain/positions/cardMetadata');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function text(value) {
  return String(value || '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function hasOptionLegs(value = {}) {
  return [
    value.legs,
    value.source?.legs,
    value.executionIntent?.legs,
    value.cardSpec?.data?.legs,
    value.card?.data?.legs
  ].some(legs => Array.isArray(legs) && legs.length > 0);
}

function isOptionStratPosition(position = {}) {
  const source = position.source || {};
  const intent = position.executionIntent || {};
  const cardData = position.card?.data || position.cardSpec?.data || {};
  const cardTypes = [
    position.cardSpec?.type,
    position.card?.type,
    source.cardType,
    intent.cardType
  ].map(lower);
  const providers = [position.provider, source.provider, intent.provider, cardData.provider].map(lower);
  const instrumentTypes = [
    position.instrumentType,
    source.instrumentType,
    intent.instrumentType,
    cardData.instrumentType
  ].map(value => text(value).toUpperCase());
  const events = [position.event, source.event, intent.event, cardData.event].map(lower);

  return cardTypes.some(type => type === 'option' || type === 'optionstrat')
    || providers.includes('optionstrat')
    || instrumentTypes.includes('OPT')
    || events.includes('optionstrat')
    || hasOptionLegs(position);
}

function uniqueTickets(...collections) {
  const tickets = [];
  const seen = new Set();
  for (const collection of collections) {
    const values = Array.isArray(collection) ? collection : [collection];
    for (const value of values) {
      const ticket = text(value);
      if (!ticket || seen.has(ticket)) continue;
      seen.add(ticket);
      tickets.push(ticket);
    }
  }
  return tickets;
}

function optionSnapshotData(position = {}, opts = {}) {
  const source = position.source || {};
  const intent = position.executionIntent || {};
  const explicitData = opts.card?.data || position.cardSpec?.data || position.card?.data || {};
  const timestamps = {
    ...(source.timestamps || {}),
    ...(intent.timestamps || {}),
    ...(explicitData.timestamps || {}),
    ...(position.timestamps || {})
  };
  const primaryTicket = firstValue(
    position.primaryTicket,
    explicitData.primaryTicket,
    explicitData.ticket,
    source.primaryTicket,
    source.ticket,
    intent.primaryTicket,
    intent.ticket
  );
  const tickets = uniqueTickets(
    primaryTicket,
    position.tickets,
    explicitData.tickets,
    source.tickets,
    intent.tickets
  );
  const ticker = firstValue(position.ticker, position.symbol, explicitData.ticker, explicitData.symbol, source.ticker, source.symbol, intent.ticker, intent.symbol);
  const symbol = firstValue(position.symbol, explicitData.symbol, source.symbol, intent.symbol, ticker);
  const provider = firstValue(position.provider, explicitData.provider, source.provider, intent.provider, 'optionstrat');
  const instrumentType = firstValue(position.instrumentType, explicitData.instrumentType, source.instrumentType, intent.instrumentType, 'OPT');
  const legs = firstValue(explicitData.legs, source.legs, intent.legs, position.legs, []);
  const payoff = firstValue(
    explicitData.payoff,
    position.payoff,
    source.payoff,
    intent.payoff,
    explicitData.estimatedPayoff,
    source.estimatedPayoff,
    intent.estimatedPayoff
  );
  const valuation = firstValue(
    explicitData.valuation,
    position.valuation,
    source.valuation,
    intent.valuation,
    position.pnlSnapshot?.raw?.valuation,
    explicitData.optionValuation,
    source.optionValuation,
    intent.optionValuation
  );

  return {
    ...pick({ ...source, ...intent, ...explicitData }, [
      'root',
      'description',
      'instantExecution',
      'isCustomName',
      'isCashSecured',
      'time',
      'side'
    ]),
    ticker,
    symbol,
    provider,
    instrumentType,
    state: position.state,
    pnl: clone(position.pnlSnapshot) || { status: 'unavailable' },
    event: firstValue(explicitData.event, source.event, intent.event, position.event, 'optionstrat'),
    strategyCommand: firstValue(explicitData.strategyCommand, source.strategyCommand, intent.strategyCommand, position.strategyCommand),
    name: firstValue(explicitData.name, source.name, intent.name, position.name, ticker),
    expirationDte: firstValue(
      explicitData.expirationDte,
      source.expirationDte,
      intent.expirationDte,
      position.expirationDte,
      explicitData.expiration,
      source.expiration,
      intent.expiration
    ),
    legs: clone(legs) || [],
    payoff: clone(payoff),
    valuation: clone(valuation),
    timestamps: clone(timestamps),
    ...pick(timestamps, [
      'createdAt',
      'openingAt',
      'placedAt',
      'openedAt',
      'closingAt',
      'closedAt',
      'archivedAt'
    ]),
    primaryTicket: primaryTicket || undefined,
    ticket: primaryTicket || undefined,
    tickets
  };
}

function optionOpenPayload(position = {}, data = {}) {
  const source = clone(position.source) || {};
  const intent = clone(position.executionIntent) || {};
  return {
    ...source,
    ...intent,
    cardType: 'option',
    ticker: data.ticker,
    symbol: data.symbol,
    provider: data.provider,
    instrumentType: data.instrumentType,
    event: data.event,
    strategyCommand: data.strategyCommand,
    name: data.name,
    expirationDte: data.expirationDte,
    legs: clone(data.legs) || [],
    payoff: clone(data.payoff),
    valuation: clone(data.valuation),
    side: firstValue(intent.side, source.side, position.side, 'OPEN')
  };
}

function optionActions(position = {}, data = {}) {
  if (isActionableState(position.state)) {
    return [{
      id: 'OPEN',
      label: 'OPEN',
      command: 'position.open',
      style: 'bl',
      payload: optionOpenPayload(position, data)
    }];
  }
  if (position.state === PositionState.CLOSED) return [];
  return lifecycleActions(position);
}

function deriveOptionStratCard(position = {}, opts = {}) {
  const data = optionSnapshotData(position, opts);
  return {
    type: 'option',
    actions: optionActions(position, data),
    data
  };
}

function createOptionStratPositionBehavior() {
  return {
    id: 'optionstrat',
    matches: isOptionStratPosition,
    deriveCard: deriveOptionStratCard
  };
}

module.exports = {
  createOptionStratPositionBehavior,
  deriveOptionStratCard,
  isOptionStratPosition,
  optionSnapshotData
};
