const assert = require('assert');
const { EventEmitter } = require('events');
const { createAdapterLifecycleBridge } = require('../app/application/execution');
const { createPositionApplicationService, legacyOrderPayloadToCreateCommand } = require('../app/application/positions');
const { createPositionBehaviorRegistry, createOpeningPolicyRegistry } = require('../app/domain/positions');
const { createLevelOrderPositionBehavior } = require('../app/services/levelOrder/domain/positionBehavior');
const { createLevelOrderOpeningPolicy } = require('../app/services/levelOrder/domain/openingPolicy');

function createPositionsWithLevelOrder(opts = {}) {
  return createPositionApplicationService({
    ...opts,
    behaviorRegistry: opts.behaviorRegistry || createPositionBehaviorRegistry([createLevelOrderPositionBehavior()]),
    openingPolicyRegistry: opts.openingPolicyRegistry || createOpeningPolicyRegistry([
      { kind: 'levelOrder', factory: createLevelOrderOpeningPolicy }
    ])
  });
}

function makeWindow(sent) {
  return {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        sent.push({ channel, payload });
      }
    }
  };
}

function run() {
  const adapter = new EventEmitter();
  adapter.on = adapter.on.bind(adapter);
  const sent = [];
  const busEvents = [];
  const eventBus = { emit: (name, payload) => busEvents.push({ name, payload }) };
  const positions = createPositionApplicationService({ eventBus, clock: () => 100 });
  const createCommand = legacyOrderPayloadToCreateCommand({
    symbol: 'AAPL',
    instrumentType: 'EQ',
    side: 'buy',
    qty: 1,
    meta: { requestId: 'req-bridge' }
  }, 'simulated');
  positions.createAndOpen(createCommand);

  const pendingIndex = new Map([
    ['cidbridge01', {
      reqId: 'req-bridge',
      cid: 'cidbridge01',
      order: {
        symbol: 'AAPL',
        provider: 'simulated',
        meta: { requestId: 'req-bridge', cid: 'cidbridge01', positionId: createCommand.positionId }
      }
    }]
  ]);
  const bridge = createAdapterLifecycleBridge({
    servicesApi: { positions },
    events: eventBus,
    appendJsonl: () => {},
    nowTs: () => 200,
    getMainWindow: () => makeWindow(sent),
    pendingIndex,
    trackerPending: new Map(),
    trackerIndex: new Map(),
    confirmedOrderByTicket: new Map(),
    confirmedOrderByCid: new Map(),
    groupedOrderLifecycles: {
      registerTicket() {},
      markOpened() {},
      removeTicket() {}
    },
    levelOrderPositionMonitors: new Map()
  });

  bridge.wireAdapter(adapter, 'simulated');
  adapter.emit('order:confirmed', { pendingId: 'cidbridge01', ticket: 'T-bridge', mtOrder: { comment: 'cid:cidbridge01' } });
  assert.strictEqual(pendingIndex.has('cidbridge01'), false);
  assert(sent.some(item => item.channel === 'execution:result' && item.payload.providerOrderId === 'T-bridge'));
  assert(busEvents.some(item => item.name === 'order:confirmed'));

  adapter.emit('position:opened', { ticket: 'T-bridge', order: { symbol: 'AAPL', comment: 'cid:cidbridge01' } });
  const snapshot = positions.snapshot().positions[0];
  assert.strictEqual(snapshot.state, 'active');
  assert.strictEqual(snapshot.primaryTicket, 'T-bridge');
  assert(sent.some(item => item.channel === 'position:opened' && item.payload.ticket === 'T-bridge'));
  assert(busEvents.some(item => item.name === 'position.opened'));

  const levelAdapter = new EventEmitter();
  levelAdapter.on = levelAdapter.on.bind(levelAdapter);
  const levelSent = [];
  const levelPositions = createPositionsWithLevelOrder({ eventBus, clock: () => 300 });
  const createdLevel = levelPositions.handle(legacyOrderPayloadToCreateCommand({
    ticker: 'ES',
    symbol: 'ES',
    provider: 'simulated',
    cardType: 'levelOrder',
    meta: { requestId: 'level-parent' }
  }, 'simulated'));
  levelPositions.handle({
    type: 'position.open',
    positionId: createdLevel.position.id,
    payload: { ticker: 'ES', cardType: 'levelOrder' },
    openingPolicy: { kind: 'levelOrder' }
  });
  const levelPendingIndex = new Map([
    ['cidlevel01', {
      reqId: 'level-parent_1',
      cid: 'cidlevel01',
      order: {
        symbol: 'ES',
        provider: 'simulated',
        meta: {
          requestId: 'level-parent_1',
          parentRequestId: 'level-parent',
          childIndex: 1,
          childCount: 1,
          cid: 'cidlevel01'
        }
      }
    }]
  ]);
  const levelBridge = createAdapterLifecycleBridge({
    servicesApi: { positions: levelPositions },
    events: eventBus,
    appendJsonl: () => {},
    nowTs: () => 400,
    getMainWindow: () => makeWindow(levelSent),
    pendingIndex: levelPendingIndex,
    trackerPending: new Map(),
    trackerIndex: new Map(),
    confirmedOrderByTicket: new Map(),
    confirmedOrderByCid: new Map(),
    groupedOrderLifecycles: {
      registerTicket() {},
      markOpened() {},
      removeTicket() {}
    },
    levelOrderPositionMonitors: new Map()
  });
  levelBridge.wireAdapter(levelAdapter, 'simulated');
  levelAdapter.emit('order:confirmed', { pendingId: 'cidlevel01', ticket: 'T-level', mtOrder: { comment: 'cid:cidlevel01' } });
  let levelSnapshot = levelPositions.snapshot().positions[0];
  assert.strictEqual(levelSnapshot.state, 'placed');
  assert.strictEqual(levelSnapshot.expectedChildren, 1);
  assert.strictEqual(levelSnapshot.children[0].requestId, 'level-parent_1');
  assert.strictEqual(levelSnapshot.children[0].ticket, 'T-level');

  levelAdapter.emit('position:opened', { ticket: 'T-level', order: { symbol: 'ES', comment: 'cid:cidlevel01' } });
  levelSnapshot = levelPositions.snapshot().positions[0];
  assert.strictEqual(levelSnapshot.state, 'active');
  assert.strictEqual(levelSnapshot.children[0].state, 'active');

  levelAdapter.emit('position:closed', { ticket: 'T-level', trade: { pnlStatus: 'reported', profit: 7 } });
  levelSnapshot = levelPositions.snapshot().positions[0];
  assert.strictEqual(levelSnapshot.state, 'closed');
  assert.strictEqual(levelSnapshot.pnlSnapshot.value, 7);

  const rejectedAdapter = new EventEmitter();
  rejectedAdapter.on = rejectedAdapter.on.bind(rejectedAdapter);
  const rejectedPositions = createPositionsWithLevelOrder({ eventBus, clock: () => 500 });
  const rejectedParent = rejectedPositions.handle(legacyOrderPayloadToCreateCommand({
    ticker: 'USTEC',
    symbol: 'USTEC',
    provider: 'mt5-gerchikco-dwx',
    cardType: 'levelOrder',
    meta: { requestId: '1785608408609_9uw6gx' }
  }, 'mt5-gerchikco-dwx'));
  rejectedPositions.handle({
    type: 'position.open',
    positionId: rejectedParent.position.id,
    payload: { ticker: 'USTEC', requestId: '1785608408609_9uw6gx', cardType: 'levelOrder' },
    openingPolicy: { kind: 'levelOrder' }
  });
  rejectedPositions.recordPlaced({
    positionId: rejectedParent.position.id,
    requestId: '1785608408609_9uw6gx_1',
    parentRequestId: '1785608408609_9uw6gx',
    childIndex: 1,
    childCount: 1,
    pendingId: 'eaeaab3819e4',
    cid: 'eaeaab3819e4',
    providerOrderId: 'pending:eaeaab3819e4',
    provider: 'mt5-gerchikco-dwx',
    payload: {
      symbol: 'USTEC',
      meta: {
        requestId: '1785608408609_9uw6gx_1',
        parentRequestId: '1785608408609_9uw6gx',
        childIndex: 1,
        childCount: 1,
        cid: 'eaeaab3819e4'
      }
    }
  });
  const rejectedPendingIndex = new Map([
    ['eaeaab3819e4', {
      reqId: '1785608408609_9uw6gx_1',
      cid: 'eaeaab3819e4',
      order: {
        symbol: 'USTEC',
        provider: 'mt5-gerchikco-dwx',
        meta: {
          requestId: '1785608408609_9uw6gx_1',
          parentRequestId: '1785608408609_9uw6gx',
          childIndex: 1,
          childCount: 1,
          cid: 'eaeaab3819e4'
        }
      }
    }]
  ]);
  const rejectedBridge = createAdapterLifecycleBridge({
    servicesApi: { positions: rejectedPositions },
    events: eventBus,
    appendJsonl: () => {},
    nowTs: () => 600,
    getMainWindow: () => makeWindow([]),
    pendingIndex: rejectedPendingIndex,
    trackerPending: new Map(),
    trackerIndex: new Map(),
    confirmedOrderByTicket: new Map(),
    confirmedOrderByCid: new Map(),
    groupedOrderLifecycles: {
      registerTicket() {},
      markOpened() {},
      removeTicket() {}
    },
    levelOrderPositionMonitors: new Map()
  });
  rejectedBridge.wireAdapter(rejectedAdapter, 'mt5-gerchikco-dwx');
  rejectedAdapter.emit('order:rejected', {
    pendingId: 'eaeaab3819e4',
    reason: 'Execution retries disabled after OPEN_ORDER error'
  });
  const rejectedSnapshot = rejectedPositions.snapshot().positions[0];
  assert.strictEqual(rejectedSnapshot.state, 'draft');
  assert.strictEqual(rejectedSnapshot.children.length, 0);
  assert.deepStrictEqual(rejectedSnapshot.card.actions.map(action => action.id), ['LB', 'LS']);
}

run();
console.log('adapterLifecycleBridge tests passed');
