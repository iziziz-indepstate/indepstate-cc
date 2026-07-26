const assert = require('assert');
const {
  PositionAggregate,
  PositionCommand,
  PositionState,
  PositionEvent,
  IntegrationCommand,
  RegularOpeningPolicy,
  LevelOrderOpeningPolicy,
  PendingOpeningPolicy,
  derivePositionCard
} = require('../app/domain/positions');
const {
  createPositionApplicationService,
  legacyOrderPayloadToCreateCommand,
  legacyRowToCreateCommand
} = require('../app/application/positions');

function eventTypes(result) {
  return (result.events || []).map(event => event.type);
}

function runAggregateLifecycleTest() {
  const position = PositionAggregate.create({
    positionId: 'pos-1',
    ticker: 'AAPL',
    provider: 'j2t',
    openingPolicy: { kind: 'regular' },
    payload: { symbol: 'AAPL', qty: 1 }
  });

  let result = position.handle({ type: PositionCommand.CREATE, time: 10 });
  assert.strictEqual(position.state, PositionState.DRAFT);
  assert.deepStrictEqual(eventTypes(result), [PositionEvent.CREATED]);

  result = position.handle({ type: PositionCommand.OPEN, payload: { symbol: 'AAPL', qty: 1 }, time: 20 });
  assert.strictEqual(position.state, PositionState.OPENING);
  assert.deepStrictEqual(eventTypes(result), [PositionEvent.OPEN_REQUESTED, PositionEvent.EXECUTION_REQUESTED]);
  assert.deepStrictEqual(result.integrationCommands.map(cmd => cmd.type), [IntegrationCommand.PLACE_ORDER]);

  result = position.handle({ type: PositionCommand.PROVIDER_PLACED, ticket: 'T-1', time: 30 });
  assert.strictEqual(position.state, PositionState.PLACED);
  assert.deepStrictEqual(eventTypes(result), [PositionEvent.PLACED]);

  result = position.handle({ type: PositionCommand.PROVIDER_OPENED, ticket: 'T-1', time: 40 });
  assert.strictEqual(position.state, PositionState.ACTIVE);
  assert.deepStrictEqual(eventTypes(result), [PositionEvent.OPENED]);

  result = position.handle({ type: PositionCommand.PROVIDER_OPENED, ticket: 'T-1', time: 41 });
  assert.deepStrictEqual(eventTypes(result), []);

  result = position.handle({ type: PositionCommand.CLOSE, time: 50 });
  assert.strictEqual(position.state, PositionState.CLOSING);
  assert.deepStrictEqual(eventTypes(result), [PositionEvent.CLOSE_REQUESTED]);
  assert.deepStrictEqual(result.integrationCommands.map(cmd => cmd.type), [IntegrationCommand.CLOSE_POSITION]);

  result = position.handle({ type: PositionCommand.PROVIDER_CLOSED, ticket: 'T-1', trade: { profit: 12 }, time: 60 });
  assert.strictEqual(position.state, PositionState.CLOSED);
  assert.deepStrictEqual(eventTypes(result), [PositionEvent.CLOSED]);
  assert.strictEqual(position.snapshot().pnlSnapshot.value, 12);

  result = position.handle({ type: PositionCommand.PNL_UPDATED, trade: { profit: 15 }, time: 70 });
  assert.strictEqual(position.state, PositionState.CLOSED);
  assert.deepStrictEqual(eventTypes(result), [PositionEvent.PNL_UPDATED]);
  assert.strictEqual(position.snapshot().pnlSnapshot.value, 15);
}

function runRejectedCancelledTest() {
  const rejected = PositionAggregate.create({ positionId: 'pos-rej', ticker: 'MSFT' });
  rejected.handle({ type: PositionCommand.CREATE });
  rejected.handle({ type: PositionCommand.OPEN, payload: { symbol: 'MSFT' } });
  const rej = rejected.handle({ type: PositionCommand.PROVIDER_REJECTED, reason: 'No quote' });
  assert.strictEqual(rejected.state, PositionState.REJECTED);
  assert.deepStrictEqual(eventTypes(rej), [PositionEvent.REJECTED]);

  const cancelled = PositionAggregate.create({ positionId: 'pos-cancel', ticker: 'TSLA' });
  cancelled.handle({ type: PositionCommand.CREATE });
  const res = cancelled.handle({ type: PositionCommand.REMOVE });
  assert.strictEqual(cancelled.state, PositionState.CANCELLED);
  assert.deepStrictEqual(eventTypes(res), [PositionEvent.REMOVED]);
}

function runPolicyTests() {
  const regular = new RegularOpeningPolicy();
  const regularResult = regular.buildOpenRequest({ id: 'p1', provider: 'simulated', source: { symbol: 'AAPL' } }, {});
  assert.deepStrictEqual(regularResult.integrationCommands.map(cmd => cmd.type), [IntegrationCommand.PLACE_ORDER]);

  const pending = new PendingOpeningPolicy({ strategy: 'falseBreak' });
  const pendingResult = pending.buildOpenRequest({ id: 'p2', provider: 'dwx', source: { symbol: 'EURUSD' } }, {});
  assert.deepStrictEqual(pendingResult.integrationCommands.map(cmd => cmd.type), [IntegrationCommand.PLACE_PENDING_ORDER]);
  assert.strictEqual(pendingResult.integrationCommands[0].payload.strategy, 'falseBreak');

  const level = new LevelOrderOpeningPolicy({ children: [{ requestId: 'c1' }, { requestId: 'c2' }] });
  const levelResult = level.buildOpenRequest({ id: 'p3', provider: 'dwx', source: { symbol: 'ES' } }, {});
  assert.deepStrictEqual(levelResult.integrationCommands.map(cmd => cmd.type), [IntegrationCommand.PLACE_LEVEL_CHILDREN]);
  assert.strictEqual(levelResult.integrationCommands[0].children.length, 2);
}

function runApplicationAndLegacyTests() {
  const service = createPositionApplicationService({ clock: () => 100 });
  const create = legacyOrderPayloadToCreateCommand({
    symbol: 'BTCUSDT',
    instrumentType: 'CX',
    side: 'buy',
    qty: 1,
    meta: { requestId: 'req-1' }
  }, 'ccxt-binance-futures');
  const opened = service.createAndOpen(create);
  assert.strictEqual(opened.ok, true);
  assert.strictEqual(opened.position.state, PositionState.OPENING);
  assert.strictEqual(service.snapshot().positions.length, 1);

  const placed = service.recordPlaced({ requestId: 'req-1', providerOrderId: 'ticket-1', provider: 'ccxt-binance-futures' });
  assert.strictEqual(placed.position.state, PositionState.PLACED);

  const active = service.recordOpened({ requestId: 'req-1', ticket: 'ticket-1', provider: 'ccxt-binance-futures' });
  assert.strictEqual(active.position.state, PositionState.ACTIVE);

  const closed = service.recordClosed({ ticket: 'ticket-1', provider: 'ccxt-binance-futures', trade: { pnlStatus: 'reported', profit: -3 } });
  assert.strictEqual(closed.position.state, PositionState.CLOSED);
  assert.strictEqual(closed.position.pnlSnapshot.value, -3);

  const rowCreate = legacyRowToCreateCommand({ ticker: 'ES', provider: 'dwx', cardType: 'levelOrder', time: 1 });
  assert.strictEqual(rowCreate.openingPolicy.kind, 'levelOrder');
}

function runCardMetadataTests() {
  const level = PositionAggregate.create({
    positionId: 'pos-level-card',
    ticker: 'ADAUSDT',
    provider: 'dwx',
    cardType: 'levelOrder',
    source: {
      cardType: 'levelOrder',
      ticker: 'ADAUSDT',
      level: 0.164,
      riskUsd: 25,
      stopOffsetPts: 4,
      maxLot: 200,
      takeProfitPts: 12,
      pointSize: 0.001
    }
  });
  level.handle({ type: PositionCommand.CREATE });
  let snapshot = level.snapshot();
  assert.strictEqual(snapshot.card.type, 'levelOrder');
  assert.deepStrictEqual(snapshot.card.actions.map(a => a.id), ['LB', 'LS']);
  assert.strictEqual(snapshot.card.data.level, 0.164);
  assert.strictEqual(snapshot.card.data.stopOffsetPts, 4);

  level.handle({ type: PositionCommand.PROVIDER_OPENED, ticket: 'L-1' });
  snapshot = level.snapshot();
  assert.deepStrictEqual(snapshot.card.actions.map(a => a.id), ['close']);

  const regularCard = derivePositionCard({
    state: PositionState.DRAFT,
    ticker: 'AAPL',
    provider: 'j2t',
    source: {
      cardActions: [{ label: 'BUY', action: 'BUY', style: 'bl' }],
      price: 100
    }
  });
  assert.strictEqual(regularCard.type, 'regular');
  assert.deepStrictEqual(regularCard.actions.map(a => a.id), ['BUY']);
  assert.strictEqual(regularCard.data.price, 100);
}

runAggregateLifecycleTest();
runRejectedCancelledTest();
runPolicyTests();
runApplicationAndLegacyTests();
runCardMetadataTests();

console.log('positionsDomain tests passed');
