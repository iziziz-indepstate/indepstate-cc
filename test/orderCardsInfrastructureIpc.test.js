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
          list: async ({ rows }) => [{ source: 'orderCards', rows }],
          getOrdersList: async (rows) => [{ source: 'legacy-webhooks', rows }]
        }
      }
    });
    assert.deepStrictEqual(await handlers.get('order-cards:list')(null, 5), [{ source: 'orderCards', rows: 5 }]);
    assert.deepStrictEqual(
      await handlers.get('order-cards:list')(null, { file: 'webhooks', rows: 8 }),
      [{ source: 'orderCards', rows: 8 }]
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
          getOrdersList: async (rows) => [{ source: 'legacy-webhooks', rows }]
        }
      }
    });
    assert.deepStrictEqual(await handlers.get('order-cards:list')(null, 6), [{ source: 'legacy-webhooks', rows: 6 }]);
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
          list: async ({ rows }) => [{ source: 'orderCards', rows }]
        }
      }
    });
    await assert.rejects(
      () => handlers.get('order-cards:list')(null, { file: 'executions', rows: 10 }),
      /Unknown order-cards file alias: executions/
    );
  }

  console.log('orderCardsInfrastructureIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
