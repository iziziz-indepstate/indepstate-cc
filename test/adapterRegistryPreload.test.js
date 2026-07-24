const assert = require('assert');
const brokerageAdapters = require('../app/services/brokerage/brokerageAdapters');
const { initExecutionConfig, getAdapter } = require('../app/services/brokerage/adapterRegistry');

async function run() {
  let preloadCalls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  brokerageAdapters.preloadtest = () => ({
    preloadInstrumentMetadata() {
      preloadCalls += 1;
      return pending;
    }
  });
  initExecutionConfig({ providers: { warm: { adapter: 'preloadtest' } } });

  const adapter = getAdapter('warm');
  assert.ok(adapter);
  assert.strictEqual(preloadCalls, 0, 'getAdapter must not await or synchronously execute preload');
  await Promise.resolve();
  assert.strictEqual(preloadCalls, 1);
  assert.strictEqual(getAdapter('warm'), adapter);
  await Promise.resolve();
  assert.strictEqual(preloadCalls, 1);
  release();

  delete brokerageAdapters.preloadtest;
  console.log('adapter registry preload tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
