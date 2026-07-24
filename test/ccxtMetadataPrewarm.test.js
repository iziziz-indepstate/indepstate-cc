const assert = require('assert');
const brokerageAdapters = require('../app/services/brokerage/brokerageAdapters');
const {
  initService,
  findConfiguredMetadataPreloadProviders,
  prewarmConfiguredInstrumentMetadata
} = require('../app/services/brokerage-adapter-ccxt/manifest');

function brokerageFor(config, calls = []) {
  return {
    getExecutionConfig() { return config; },
    getAdapter(provider) { calls.push(provider); return { provider }; }
  };
}

function run() {
  const config = {
    default: 'simulated',
    byInstrumentType: { CX: 'binance-main', EQ: 'dwx' },
    bySymbol: {
      'ETHUSDT.P': 'BINANCE-MAIN',
      'MOVRUSDT.P': 'binance-alt',
      AAPL: 'unused-ccxt'
    },
    providers: {
      'binance-main': { adapter: 'ccxt', exchangeId: 'binance' },
      'binance-alt': { adapter: 'ccxt', exchangeId: 'binanceusdm' },
      'unused-ccxt': { adapter: 'ccxt', exchangeId: 'binance' },
      dwx: { adapter: 'dwx' },
      simulated: { adapter: 'simulated' }
    }
  };
  const calls = [];
  const brokerage = brokerageFor(config, calls);
  assert.deepStrictEqual(findConfiguredMetadataPreloadProviders(brokerage), ['binance-main', 'binance-alt']);
  assert.deepStrictEqual(prewarmConfiguredInstrumentMetadata(brokerage), ['binance-main', 'binance-alt']);
  assert.deepStrictEqual(calls, ['binance-main', 'binance-alt']);

  const fallback = brokerageFor({
    default: 'binance-default',
    byInstrumentType: { EQ: 'dwx' },
    providers: { 'binance-default': { adapter: 'ccxt', exchangeId: 'binance-futures' }, dwx: { adapter: 'dwx' } }
  });
  assert.deepStrictEqual(findConfiguredMetadataPreloadProviders(fallback), ['binance-default']);

  const nonBinance = brokerageFor({
    default: 'simulated',
    byInstrumentType: { CX: 'generic-ccxt' },
    providers: { 'generic-ccxt': { adapter: 'ccxt', exchangeId: 'okx' }, simulated: { adapter: 'simulated' } }
  });
  assert.deepStrictEqual(findConfiguredMetadataPreloadProviders(nonBinance), []);

  let registration;
  initService({
    brokerage,
    instrumentInfo: {
      registerMetadataPrewarmer(name, callback) { registration = { name, callback }; }
    }
  });
  assert.strictEqual(typeof brokerageAdapters.ccxt, 'function');
  assert.strictEqual(registration.name, 'ccxt-binance-futures');
  calls.length = 0;
  registration.callback();
  assert.deepStrictEqual(calls, ['binance-main', 'binance-alt']);

  console.log('CCXT metadata prewarm tests passed');
}

run();
