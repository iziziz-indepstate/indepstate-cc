const assert = require('assert');
const {
  mainApplicationServicePhaseFor,
  shouldRegisterMainApplicationService,
  registerMainApplicationServicesForManifests
} = require('../app/services/serviceMainRegistration');

function run() {
  const calls = [];
  const early = {
    mainApplicationServicePhase: 'before-window',
    registerMainApplicationServices(context) {
      calls.push(['early', context.serviceDir, context.phase]);
    }
  };
  const late = {
    registerMainApplicationServices(context) {
      calls.push(['late', context.serviceDir, context.phase]);
    }
  };

  assert.strictEqual(mainApplicationServicePhaseFor({}), 'after-execution');
  assert.strictEqual(shouldRegisterMainApplicationService(early, { phase: 'before-window' }), true);
  assert.strictEqual(shouldRegisterMainApplicationService(early, { phase: 'after-execution' }), false);
  assert.strictEqual(shouldRegisterMainApplicationService(late, { phase: 'after-execution' }), true);
  assert.strictEqual(shouldRegisterMainApplicationService(late, {}), true);
  assert.strictEqual(shouldRegisterMainApplicationService({ mainApplicationServicePhase: 'before-window' }, { phase: 'before-window' }), false);

  registerMainApplicationServicesForManifests([
    { dir: 'services/orderCards', manifest: early },
    { dir: 'services/levelOrder', manifest: late },
    { dir: 'services/optionstrat', manifest: late }
  ], { phase: 'before-window' });

  assert.deepStrictEqual(calls, [['early', 'services/orderCards', 'before-window']]);
  calls.length = 0;

  registerMainApplicationServicesForManifests([
    { dir: 'services/orderCards', manifest: early },
    { dir: 'services/levelOrder', manifest: late },
    { dir: 'services/optionstrat', manifest: late }
  ], { phase: 'after-execution' });

  assert.deepStrictEqual(calls, [
    ['late', 'services/levelOrder', 'after-execution'],
    ['late', 'services/optionstrat', 'after-execution']
  ]);

  console.log('serviceMainRegistration tests passed');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
