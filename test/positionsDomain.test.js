const assert = require('assert');
const {
  PositionAggregate,
  PositionCommand,
  PositionState,
  PositionEvent,
  IntegrationCommand,
  RegularOpeningPolicy,
  PendingOpeningPolicy,
  createPositionBehaviorRegistry,
  createOpeningPolicyRegistry,
  derivePositionCard
} = require('../app/domain/positions');
const { createLevelOrderPositionBehavior } = require('../app/services/levelOrder/domain/positionBehavior');
const { LevelOrderOpeningPolicy, createLevelOrderOpeningPolicy } = require('../app/services/levelOrder/domain/openingPolicy');
const { LevelOrderIntegrationCommand } = require('../app/services/levelOrder/domain/types');
const {
  createPositionApplicationService,
  legacyOrderPayloadToCreateCommand,
  legacyRowToCreateCommand,
  registerLegacyPositionGuard
} = require('../app/application/positions');
const { createLevelOrderLegacyGuard } = require('../app/services/levelOrder/legacyGuard');
const { createOptionStratLegacyGuard } = require('../app/services/optionstrat/legacyGuard');

registerLegacyPositionGuard(createLevelOrderLegacyGuard());

function eventTypes(result) {
  return (result.events || []).map(event => event.type);
}

function levelOrderBehaviorRegistry() {
  return createPositionBehaviorRegistry([createLevelOrderPositionBehavior()]);
}

function levelOrderOpeningPolicyRegistry() {
  return createOpeningPolicyRegistry([{ kind: 'levelOrder', factory: createLevelOrderOpeningPolicy }]);
}

function createPositionsWithLevelOrder(opts = {}) {
  return createPositionApplicationService({
    ...opts,
    behaviorRegistry: opts.behaviorRegistry || levelOrderBehaviorRegistry(),
    openingPolicyRegistry: opts.openingPolicyRegistry || levelOrderOpeningPolicyRegistry()
  });
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
  assert.deepStrictEqual(levelResult.integrationCommands.map(cmd => cmd.type), [LevelOrderIntegrationCommand.PLACE_CHILDREN]);
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

  const optionRowWithoutGuard = legacyRowToCreateCommand({ ticker: 'SPY', provider: 'optionstrat', instrumentType: 'OPT', time: 2 });
  assert.strictEqual(optionRowWithoutGuard.cardType, 'regular');
  assert.strictEqual(optionRowWithoutGuard.card.type, 'regular');

  const optionPayloadWithoutGuard = legacyOrderPayloadToCreateCommand({
    ticker: 'SPY',
    provider: 'optionstrat',
    instrumentType: 'OPT',
    meta: { requestId: 'option-without-guard' }
  }, 'optionstrat');
  assert.strictEqual(optionPayloadWithoutGuard.cardType, undefined);
  assert.strictEqual(optionPayloadWithoutGuard.card.type, undefined);

  const regularPayloadWithPositionId = legacyOrderPayloadToCreateCommand({
    ticker: 'MSFT',
    provider: 'simulated',
    instrumentType: 'EQ',
    meta: { requestId: 'regular-open-existing', positionId: 'pos-reg-existing' }
  }, 'simulated');
  assert.strictEqual(regularPayloadWithPositionId.positionId, 'pos-reg-existing');

  const unregisterOptionGuard = registerLegacyPositionGuard(createOptionStratLegacyGuard());
  try {
    const optionRowWithGuard = legacyRowToCreateCommand({ ticker: 'SPY', provider: 'optionstrat', instrumentType: 'OPT', time: 2 });
    assert.strictEqual(optionRowWithGuard.cardType, 'option');
    assert.strictEqual(optionRowWithGuard.card.type, 'option');

    const optionPayloadWithGuard = legacyOrderPayloadToCreateCommand({
      ticker: 'SPY',
      provider: 'optionstrat',
      instrumentType: 'OPT',
      meta: { requestId: 'option-with-guard' }
    }, 'optionstrat');
    assert.strictEqual(optionPayloadWithGuard.cardType, 'option');
    assert.strictEqual(optionPayloadWithGuard.card.type, 'option');

    const explicitCardType = legacyRowToCreateCommand({
      ticker: 'SPY',
      provider: 'optionstrat',
      instrumentType: 'OPT',
      cardType: 'customOption'
    });
    assert.strictEqual(explicitCardType.cardType, 'customOption');
  } finally {
    unregisterOptionGuard();
  }
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
  }, { behaviorRegistry: levelOrderBehaviorRegistry() });
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

function runLevelOrderParentLifecycleTest() {
  const service = createPositionsWithLevelOrder({ clock: () => 100 });
  const created = service.handle(legacyRowToCreateCommand({
    positionId: 'level-parent',
    ticker: 'ES',
    provider: 'simulated',
    cardType: 'levelOrder',
    level: 100,
    riskUsd: 50,
    stopOffsetPts: 4,
    maxLot: 2
  }));
  const opened = service.handle({
    type: PositionCommand.OPEN,
    positionId: created.position.id,
    payload: { ticker: 'ES', cardType: 'levelOrder' },
    openingPolicy: { kind: 'levelOrder' }
  }, { behaviorRegistry: levelOrderBehaviorRegistry() });
  assert.strictEqual(opened.position.state, PositionState.OPENING);

  const placed1 = service.recordPlaced({
    positionId: opened.position.id,
    requestId: 'parent-1_1',
    parentRequestId: 'parent-1',
    childIndex: 1,
    childCount: 2,
    pendingId: 'cid-1',
    providerOrderId: 'ticket-1',
    provider: 'simulated',
    payload: { meta: { requestId: 'parent-1_1', parentRequestId: 'parent-1', childIndex: 1, childCount: 2 } }
  }, { behaviorRegistry: levelOrderBehaviorRegistry() });
  assert.strictEqual(placed1.position.state, PositionState.PLACED);
  assert.strictEqual(placed1.position.expectedChildren, 2);
  assert.strictEqual(placed1.position.children.length, 1);
  assert.strictEqual(placed1.position.card.data.expectedChildren, 2);
  assert.strictEqual(placed1.position.card.data.children.length, 1);

  service.recordPlaced({
    positionId: opened.position.id,
    requestId: 'parent-1_2',
    parentRequestId: 'parent-1',
    childIndex: 2,
    childCount: 2,
    providerOrderId: 'ticket-2',
    provider: 'simulated',
    payload: { meta: { requestId: 'parent-1_2', parentRequestId: 'parent-1', childIndex: 2, childCount: 2 } }
  });
  const oneOpened = service.recordOpened({
    positionId: opened.position.id,
    requestId: 'parent-1_1',
    parentRequestId: 'parent-1',
    childIndex: 1,
    childCount: 2,
    ticket: 'ticket-1',
    provider: 'simulated'
  });
  assert.strictEqual(oneOpened.position.state, PositionState.PLACED);

  const allOpened = service.recordOpened({
    positionId: opened.position.id,
    requestId: 'parent-1_2',
    parentRequestId: 'parent-1',
    childIndex: 2,
    childCount: 2,
    ticket: 'ticket-2',
    provider: 'simulated'
  });
  assert.strictEqual(allOpened.position.state, PositionState.ACTIVE);

  const closeRequested = service.remove({ positionId: opened.position.id, reason: 'test.close' });
  assert.strictEqual(closeRequested.position.state, PositionState.CLOSING);

  const firstClosed = service.recordClosed({
    positionId: opened.position.id,
    requestId: 'parent-1_1',
    parentRequestId: 'parent-1',
    ticket: 'ticket-1',
    provider: 'simulated',
    trade: { pnlStatus: 'reported', profit: 5 },
    final: false
  });
  assert.strictEqual(firstClosed.position.state, PositionState.CLOSING);

  const secondClosed = service.recordClosed({
    positionId: opened.position.id,
    requestId: 'parent-1_2',
    parentRequestId: 'parent-1',
    ticket: 'ticket-2',
    provider: 'simulated',
    trade: { pnlStatus: 'reported', profit: -2 },
    final: false
  });
  assert.strictEqual(secondClosed.position.state, PositionState.CLOSED);
  assert.strictEqual(secondClosed.position.pnlSnapshot.value, 3);
}

function runLevelOrderPartialPlacementTest() {
  const service = createPositionsWithLevelOrder();
  const created = service.handle(legacyRowToCreateCommand({ positionId: 'partial-parent', ticker: 'NQ', provider: 'simulated', cardType: 'levelOrder' }));
  service.handle({ type: PositionCommand.OPEN, positionId: created.position.id, payload: { ticker: 'NQ' }, openingPolicy: { kind: 'levelOrder' } });
  service.recordPlaced({
    positionId: created.position.id,
    requestId: 'partial_1',
    parentRequestId: 'partial',
    childIndex: 1,
    childCount: 2,
    providerOrderId: 'ticket-p1',
    provider: 'simulated'
  });
  const rejected = service.recordRejected({
    positionId: created.position.id,
    requestId: 'partial_2',
    parentRequestId: 'partial',
    childIndex: 2,
    childCount: 2,
    provider: 'simulated',
    reason: 'No quote'
  });
  assert.strictEqual(rejected.position.state, PositionState.DRAFT);
  assert.strictEqual(rejected.position.children.length, 0);
  assert.strictEqual(service.snapshot().positions.length, 1);
}

function runLevelOrderPreOpenClosedResetsDraftTest() {
  const service = createPositionsWithLevelOrder();
  const created = service.handle(legacyRowToCreateCommand({ positionId: 'closed-before-open', ticker: 'YM', provider: 'simulated', cardType: 'levelOrder' }));
  service.handle({ type: PositionCommand.OPEN, positionId: created.position.id, payload: { ticker: 'YM' }, openingPolicy: { kind: 'levelOrder' } });
  service.recordPlaced({
    positionId: created.position.id,
    requestId: 'preopen_1',
    parentRequestId: 'preopen',
    childIndex: 1,
    childCount: 1,
    providerOrderId: 'ticket-preopen',
    provider: 'simulated'
  });
  const closed = service.recordClosed({
    positionId: created.position.id,
    requestId: 'preopen_1',
    parentRequestId: 'preopen',
    ticket: 'ticket-preopen',
    provider: 'simulated',
    trade: { pnlStatus: 'unavailable', reason: 'Broker rejected before open' },
    final: false
  });
  assert.strictEqual(closed.position.state, PositionState.DRAFT);
  assert.deepStrictEqual(closed.position.card.actions.map(action => action.id), ['LB', 'LS']);
  assert.strictEqual(closed.position.children.length, 0);
  assert.strictEqual(closed.position.tickets.length, 0);
}

runAggregateLifecycleTest();
runRejectedCancelledTest();
runPolicyTests();
runApplicationAndLegacyTests();
runCardMetadataTests();
runLevelOrderParentLifecycleTest();
runLevelOrderPartialPlacementTest();
runLevelOrderPreOpenClosedResetsDraftTest();

console.log('positionsDomain tests passed');
