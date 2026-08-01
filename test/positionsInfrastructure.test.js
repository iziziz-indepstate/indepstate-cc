const assert = require('assert');
const { createPositionApplicationService, legacyRowToCreateCommand } = require('../app/application/positions');
const { registerPositionsIpcHandlers, createPositionsChangedPublisher } = require('../app/infrastructure/positions');

async function run() {
  const positions = createPositionApplicationService({ clock: () => 100 });
  const createCommand = legacyRowToCreateCommand({
    ticker: 'ADAUSDT',
    cardType: 'levelOrder',
    provider: 'simulated',
    instrumentType: 'CX',
    time: 1,
    level: 0.164,
    riskUsd: 25,
    stopOffsetPts: 4,
    maxLot: 200,
    takeProfitPts: 12
  });

  const handlers = new Map();
  registerPositionsIpcHandlers({
    ipcMain: {
      handle(name, fn) {
        handlers.set(name, fn);
      }
    },
    positionsService: positions
  });

  const sent = [];
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        sent.push({ channel, payload });
      }
    }
  };
  const publisher = createPositionsChangedPublisher({
    positionsService: positions,
    getMainWindow: () => mainWindow
  });

  const created = positions.handle(createCommand);
  assert.strictEqual(created.ok, true);

  const listed = await handlers.get('positions:list')();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].card.type, 'levelOrder');
  assert.deepStrictEqual(listed[0].card.actions.map(action => action.id), ['LB', 'LS']);
  assert.strictEqual(listed[0].card.data.level, 0.164);

  const createdPayload = sent.find(item => item.payload.event.type === 'position.created')?.payload;
  assert(createdPayload);
  assert.strictEqual(createdPayload.position.id, created.position.id);
  assert.strictEqual(createdPayload.position.card.type, 'levelOrder');
  assert.deepStrictEqual(createdPayload.position.card.actions.map(action => action.id), ['LB', 'LS']);
  assert.strictEqual(createdPayload.position.card.data.stopOffsetPts, 4);

  const removed = await handlers.get('positions:remove')(null, { positionId: created.position.id, reason: 'test' });
  assert.strictEqual(removed.ok, true);
  const removedPayload = sent.find(item => item.payload.event.type === 'position.removed')?.payload;
  assert(removedPayload);
  assert.strictEqual(removedPayload.position.id, created.position.id);
  assert.strictEqual((await handlers.get('positions:list')()).length, 0);

  const openedCreate = positions.handle({
    ...createCommand,
    positionId: 'pos-opened-infrastructure-test'
  });
  positions.recordOpened({ positionId: openedCreate.position.id, ticket: 'ticket-1', provider: 'simulated' });
  const openedPayload = sent.find(item => item.payload.event.type === 'position.opened')?.payload;
  assert(openedPayload);
  assert.strictEqual(openedPayload.position.card.type, 'levelOrder');
  assert(openedPayload.position.card.data);

  publisher.dispose();
  console.log('positionsInfrastructure tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
