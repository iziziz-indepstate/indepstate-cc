const assert = require('assert');
const {
  initExecutionConfig,
  getAdapter,
  getExecutionConfig,
  registerAdapterFactory,
  registerExecutionProviderDefaults,
  hasAdapterFactory,
  listAdapterFactories
} = require('../app/services/brokerage/adapterRegistry');

async function run() {
  const oldFactory = () => ({ id: 'old' });
  const newFactory = () => ({ id: 'new' });
  const unregisterOld = registerAdapterFactory('SwapTest', oldFactory);
  assert.strictEqual(hasAdapterFactory('swaptest'), true);
  assert(listAdapterFactories().includes('swaptest'));
  initExecutionConfig({ providers: { swap: { adapter: 'swaptest' } } });
  assert.strictEqual(getAdapter('swap').id, 'old');

  const unregisterNew = registerAdapterFactory('swaptest', newFactory);
  assert.strictEqual(getAdapter('swap').id, 'new', 'duplicate registration must replace cached instances');
  assert.strictEqual(unregisterOld(), false, 'old unregister must not remove a replacement factory');
  assert.strictEqual(getAdapter('swap').id, 'new');
  assert.strictEqual(unregisterNew(), true);
  assert.strictEqual(hasAdapterFactory('swaptest'), false);

  const unregisterExtension = registerAdapterFactory('extensiontest', cfg => ({ cfg }));
  initExecutionConfig({
    default: 'simulated',
    byInstrumentType: { EQ: 'simulated' },
    providers: {
      simulated: { adapter: 'simulated' }
    }
  });
  assert.strictEqual(getExecutionConfig().byInstrumentType.OPT, undefined);
  registerExecutionProviderDefaults({
    routingDefaults: { byInstrumentType: { OPT: 'extension-provider' } },
    providers: {
      'extension-provider': {
        adapter: 'extensiontest',
        baseURL: 'https://default.example',
        timeoutMs: 10000
      }
    }
  });
  assert.strictEqual(getExecutionConfig().byInstrumentType.OPT, 'extension-provider');
  assert.strictEqual(getExecutionConfig().providers['extension-provider'].baseURL, 'https://default.example');
  assert.strictEqual(getAdapter('extension-provider').cfg.timeoutMs, 10000);

  initExecutionConfig({
    default: 'simulated',
    byInstrumentType: { OPT: 'custom-options' },
    providers: {
      'extension-provider': {
        adapter: 'extensiontest',
        baseURL: 'https://override.example'
      },
      'custom-options': { adapter: 'extensiontest' }
    }
  });
  registerExecutionProviderDefaults({
    routingDefaults: { byInstrumentType: { OPT: 'extension-provider' } },
    providers: {
      'extension-provider': {
        adapter: 'extensiontest',
        baseURL: 'https://default.example',
        timeoutMs: 10000
      }
    }
  });
  assert.strictEqual(getExecutionConfig().byInstrumentType.OPT, 'custom-options');
  assert.strictEqual(getExecutionConfig().providers['extension-provider'].baseURL, 'https://override.example');
  assert.strictEqual(getExecutionConfig().providers['extension-provider'].timeoutMs, 10000);
  unregisterExtension();

  let preloadCalls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const unregisterPreload = registerAdapterFactory('preloadtest', () => ({
    preloadInstrumentMetadata() {
      preloadCalls += 1;
      return pending;
    }
  }));
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

  unregisterPreload();
  console.log('adapter registry preload tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
