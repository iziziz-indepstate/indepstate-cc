const assert = require('assert');
const { createOptionStratRenderer } = require('../app/services/optionstrat/renderer');

async function run() {
  const scheduled = [];
  const renderer = createOptionStratRenderer({
    ipcRenderer: {
      invoke: async () => {
        throw new Error('valuation should not run without entries');
      }
    },
    el: () => ({ appendChild: () => {}, dataset: {}, style: {}, classList: { add: () => {}, remove: () => {} } }),
    render: () => {},
    getPositions: () => [],
    setTimeoutFn(fn, ms) {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    getValuationRefreshMs: () => 1000
  });

  renderer.startValuationRefresh();
  assert.strictEqual(scheduled.length, 1);
  await scheduled[0].fn();
  assert.strictEqual(scheduled.length, 2);

  console.log('optionstratValuationRefresh tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
