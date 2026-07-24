const assert = require('assert');
const { createInstrumentInfoService } = require('../app/services/instrumentInfo');

async function run() {
  const scheduled = [];
  const errors = [];
  const brokerage = { getAdapter() { return {}; } };
  const service = createInstrumentInfoService({
    brokerage,
    schedule(callback) { scheduled.push(callback); },
    onError(error, context) { errors.push({ message: error.message, context }); }
  });

  let calls = 0;
  const unregister = service.registerMetadataPrewarmer('one', ({ brokerage: injected }) => {
    assert.strictEqual(injected, brokerage);
    calls += 1;
  });
  assert.strictEqual(typeof unregister, 'function');
  assert.strictEqual(service.registerMetadataPrewarmer('one', () => {}), null);

  const cancel = service.registerMetadataPrewarmer('cancelled', () => { calls += 10; });
  assert.strictEqual(cancel(), true);
  service.registerMetadataPrewarmer('failing', () => { throw new Error('prewarm failed'); });
  assert.strictEqual(scheduled.length, 3);
  scheduled.forEach(callback => callback());
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(errors, [{
    message: 'prewarm failed',
    context: { section: 'metadata-prewarm', name: 'failing' }
  }]);
  assert.strictEqual(unregister(), true);

  console.log('instrument info prewarmer tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
