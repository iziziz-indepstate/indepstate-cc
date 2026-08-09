const assert = require('assert');
const { registerOrderCardsIpcHandlers } = require('../app/services/orderCards/infrastructure/ipc');

async function run() {
  {
    const handlers = new Map();
    const ipcMain = {
      handle(name, fn) {
        handlers.set(name, fn);
      }
    };
    registerOrderCardsIpcHandlers({
      ipcMain,
      servicesApi: {
        orderCards: {
          list: async ({ source, rows }) => [{ source, rows }]
        }
      }
    });
    assert.deepStrictEqual(
      await handlers.get('order-cards:list')(null, { source: 'webhooks', rows: 8 }),
      [{ source: 'webhooks', rows: 8 }]
    );
    assert.deepStrictEqual(
      await handlers.get('order-cards:list')(null, {}),
      [{ source: 'webhooks', rows: 100 }]
    );
    await assert.rejects(
      () => handlers.get('order-cards:list')(null),
      /order-cards:list request must be an object/
    );
    await assert.rejects(
      () => handlers.get('order-cards:list')(null, null),
      /order-cards:list request must be an object/
    );
  }

  {
    const handlers = new Map();
    const ipcMain = {
      handle(name, fn) {
        handlers.set(name, fn);
      }
    };
    registerOrderCardsIpcHandlers({
      ipcMain,
      servicesApi: {
        orderCards: {
          list: async ({ source, rows }) => [{ source, rows }]
        }
      }
    });
    await assert.rejects(
      () => handlers.get('order-cards:list')(null, { source: 'executions', rows: 10 }),
      /Unknown order-cards source: executions/
    );
    await assert.rejects(
      () => handlers.get('order-cards:list')(null, { file: 'webhooks', rows: 10 }),
      /order-cards:list no longer accepts file aliases/
    );
  }

  console.log('orderCardsInfrastructureIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
