const assert = require('assert');
const fs = require('fs');
const path = require('path');

function brokerageRecorder(registrations) {
  return {
    registerAdapterFactory(name, factory) {
      registrations.push({ name, factory });
      return () => true;
    },
    getExecutionConfig() { return {}; },
    getAdapter() { throw new Error('getAdapter should not be called during manifest registration'); }
  };
}

function assertRegistration(manifestPath, expectedName, servicesApi = {}) {
  const registrations = [];
  const manifest = require(manifestPath);
  manifest.initService({
    ...servicesApi,
    brokerage: brokerageRecorder(registrations)
  });
  assert.strictEqual(registrations.length, 1, `${manifestPath} must register one adapter factory`);
  assert.strictEqual(registrations[0].name, expectedName);
  assert.strictEqual(typeof registrations[0].factory, 'function');
}

assertRegistration('../app/services/brokerage-adapter-ccxt/manifest', 'ccxt', {
  instrumentInfo: { registerMetadataPrewarmer() {} }
});
assertRegistration('../app/services/brokerage-adapter-dwx/manifest', 'dwx');
assertRegistration('../app/services/brokerage-adapter-j2t/manifest', 'j2t');
assertRegistration('../app/services/brokerage-adapter-ibkr/manifest', 'ibkr');
assertRegistration('../app/services/brokerage-adapter-simulated/manifest', 'simulated');
assertRegistration('../app/services/optionstrat/manifest', 'optionstrat', {
  executionPayloadPolicies: { register() {} },
  positions: { registerLegacyGuard() {} },
  events: {},
  commands: []
});

const activeManifestFiles = [
  'app/services/brokerage-adapter-ccxt/manifest.js',
  'app/services/brokerage-adapter-dwx/manifest.js',
  'app/services/brokerage-adapter-j2t/manifest.js',
  'app/services/brokerage-adapter-ibkr/manifest.js',
  'app/services/brokerage-adapter-simulated/manifest.js',
  'app/services/optionstrat/manifest.js'
];

for (const file of activeManifestFiles) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.strictEqual(source.includes('brokerageAdapters'), false, `${file} must not import or mutate brokerageAdapters directly`);
}

console.log('brokerage adapter manifest tests passed');
