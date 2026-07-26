const assert = require('assert');
const { EventEmitter } = require('events');
const { createAdapterLifecycleBridge } = require('../app/application/execution');
const { createPositionApplicationService, legacyOrderPayloadToCreateCommand } = require('../app/application/positions');

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
}

run();
console.log('adapterLifecycleBridge tests passed');
