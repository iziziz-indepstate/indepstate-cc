const assert = require('assert');
const {
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

  console.log('electronInfrastructureIpc tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
