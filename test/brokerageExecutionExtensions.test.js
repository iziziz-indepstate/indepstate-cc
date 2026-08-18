const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('../app/services/settings');
const loadConfig = require('../app/config/load');
const brokerageManifest = require('../app/services/brokerage/manifest');
const optionstratManifest = require('../app/services/optionstrat/manifest');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iscc-brokerage-extension-'));
const overrideDir = path.join(root, 'config');
fs.mkdirSync(overrideDir, { recursive: true });
loadConfig.CONFIG_ROOTS.length = 0;
loadConfig.CONFIG_ROOTS.push(overrideDir);
loadConfig.USER_ROOT = root;

const baseDescriptor = require('../app/services/brokerage/config/execution-settings-descriptor.json');
assert.strictEqual(baseDescriptor.options.byInstrumentType.OPT, undefined);
assert.strictEqual(baseDescriptor.options.byInstrumentType.__allowUnknown, true);
assert.strictEqual(baseDescriptor.options.providers.optionstrat, undefined);
assert.strictEqual(baseDescriptor.options.providers.__allowUnknown, true);

const servicesApi = {
  executionPayloadPolicies: { register() {} },
  positions: { registerPositionInputAdapter() {} },
  events: {},
  commands: []
};

brokerageManifest.initService(servicesApi);
assert.strictEqual(servicesApi.brokerage.getExecutionConfig().byInstrumentType.OPT, undefined);
assert.strictEqual(servicesApi.brokerage.getExecutionConfig().providers.optionstrat, undefined);

optionstratManifest.initService(servicesApi);

const executionConfig = servicesApi.brokerage.getExecutionConfig();
assert.strictEqual(executionConfig.byInstrumentType.OPT, 'optionstrat');
assert.strictEqual(executionConfig.providers.optionstrat.adapter, 'optionstrat');
assert.strictEqual(executionConfig.providers.optionstrat.baseURL, 'https://optionstrat.com/api');

const { config, descriptor } = settings.readConfig('execution');
assert.strictEqual(config.byInstrumentType.OPT, 'optionstrat');
assert.strictEqual(config.providers.optionstrat.adapter, 'optionstrat');
assert.strictEqual(descriptor.options.byInstrumentType.OPT.type, 'string');
assert.strictEqual(descriptor.options.providers.optionstrat.timeoutMs.type, 'number');

console.log('brokerage execution extension tests passed');
