const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  registerOrderListIpcHandlers,
  registerWindowStateIpcHandlers
} = require('../app/infrastructure/electron');

async function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) {
      handlers.set(name, fn);
    }
  };

  registerWindowStateIpcHandlers({
    ipcMain,
    getWindowStateSnapshot: () => ({ width: 800 }),
    setWindowState: (state) => ({ ...state, saved: true })
  });
  assert.deepStrictEqual(await handlers.get('window:get-state')(), { width: 800 });
  assert.deepStrictEqual(await handlers.get('window:set-state')(null, { width: 900 }), { width: 900, saved: true });

  const execLog = path.join(os.tmpdir(), 'electronInfrastructureIpc.executions.jsonl');
  fs.mkdirSync(path.dirname(execLog), { recursive: true });
  fs.writeFileSync(execLog, '{"kind":"one"}\nnot-json\n{"kind":"two"}\n');

  registerOrderListIpcHandlers({
    ipcMain,
    orderService: {
      getOrdersList: async (rows) => [{ source: 'webhooks', rows }]
    },
    execLog
  });
  assert.deepStrictEqual(await handlers.get('orders:list')(null, 5), [{ source: 'webhooks', rows: 5 }]);
  assert.deepStrictEqual(await handlers.get('orders:list')(null, { file: 'executions', rows: 10 }), [{ kind: 'one' }, { kind: 'two' }]);

  console.log('electronInfrastructureIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
