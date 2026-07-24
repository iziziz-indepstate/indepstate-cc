const assert = require('assert');
const { createProviderResolver, normalizeProvider, normalizeSymbol } = require('../app/services/brokerage/providerResolver');

function run() {
  assert.strictEqual(normalizeProvider(' DWX '), 'dwx');
  assert.strictEqual(normalizeSymbol(' btcusdt.p '), 'BTCUSDT.P');

  const cfg = {
    default: 'Simulated',
    bySymbol: {
      'btcusdt.p': 'CCXT-BINANCE-FUTURES',
      AAPL: 'J2T'
    },
    byInstrumentType: {
      CX: 'ccxt-binance-futures',
      EQ: 'dwx',
      FX: 'dwx'
    }
  };
  const resolver = createProviderResolver({ getExecutionConfig: () => cfg });

  assert.deepStrictEqual(
    resolver.resolveProvider({ provider: ' J2T ', symbol: 'BTCUSDT.P', instrumentType: 'CX' }),
    { provider: 'j2t', source: 'explicit', matchedKey: 'provider' }
  );
  assert.deepStrictEqual(
    resolver.resolveProvider({ symbol: ' BTCUSDT.P ' }),
    { provider: 'ccxt-binance-futures', source: 'bySymbol', matchedKey: 'btcusdt.p' }
  );
  assert.deepStrictEqual(
    resolver.resolveProvider({ symbol: 'EURUSD' }),
    { provider: 'dwx', source: 'byInstrumentType', matchedKey: 'FX' }
  );
  assert.deepStrictEqual(
    resolver.resolveProvider({ instrumentType: 'EQ' }),
    { provider: 'dwx', source: 'byInstrumentType', matchedKey: 'EQ' }
  );
  assert.deepStrictEqual(
    createProviderResolver({ getExecutionConfig: () => ({ default: 'SIMULATED' }) }).resolveProvider({}),
    { provider: 'simulated', source: 'default', matchedKey: 'default' }
  );
  assert.deepStrictEqual(
    createProviderResolver({ getExecutionConfig: () => ({}) }).resolveProvider({}),
    { provider: 'simulated', source: 'fallback', matchedKey: 'hardcoded' }
  );

  const adapterResolver = createProviderResolver({
    getExecutionConfig: () => cfg,
    getAdapter(provider) {
      return { provider };
    }
  });
  assert.deepStrictEqual(
    adapterResolver.resolveAdapter({ row: { ticker: 'AAPL' } }),
    { provider: 'j2t', source: 'bySymbol', matchedKey: 'AAPL', adapter: { provider: 'j2t' } }
  );

  console.log('providerResolver tests passed');
}

run();
