const assert = require('assert');
const { CCXTExecutionAdapter } = require('../app/services/brokerage-adapter-ccxt/comps/ccxt');
const { SimulatedAdapter } = require('../app/services/brokerage-adapter-simulated/comps/simulated');

async function run() {
  const ccxtAdapter = Object.create(CCXTExecutionAdapter.prototype);
  ccxtAdapter.provider = 'ccxt-test';
  let genericReadyCalls = 0;
  ccxtAdapter.ensureReady = async () => { genericReadyCalls += 1; };
  ccxtAdapter.mapSymbol = () => 'AAA/USDT:USDT';
  ccxtAdapter._isBinanceUsdmLike = () => false;
  ccxtAdapter._getTickSizeFromMarket = () => 0.01;
  ccxtAdapter.exchange = {
    markets: {
      'AAA/USDT:USDT': {
        precision: { amount: 3 },
        limits: { amount: { min: 0.01, max: 100 }, cost: { min: 5 } },
        contractSize: 10
      }
    },
    market(symbol) { return this.markets[symbol]; }
  };
  const metadata = await ccxtAdapter.getInstrumentMetadata('AAAUSDT.P');
  assert.strictEqual(genericReadyCalls, 1);
  assert.deepStrictEqual(metadata, {
    tickSize: 0.01,
    quantityStep: 0.001,
    minQty: 0.01,
    maxQty: 100,
    minNotional: 5,
    contractSize: 10,
    sources: {
      tickSize: 'ccxt-market',
      quantityStep: 'ccxt-market',
      minQty: 'ccxt-market',
      maxQty: 'ccxt-market',
      minNotional: 'ccxt-market',
      contractSize: 'ccxt-market'
    }
  });

  const exchangeInfo = {
    symbols: [{
      symbol: 'AAAUSDT',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '500' },
        { filterType: 'MIN_NOTIONAL', notional: '5' }
      ]
    }]
  };
  const binance = Object.create(CCXTExecutionAdapter.prototype);
  binance.provider = 'binance-test';
  binance.exchangeId = 'binance';
  binance._binanceExchangeInfoCache = null;
  binance._binanceExchangeInfoLoadedAt = 0;
  binance._binanceExchangeInfoPromise = null;
  binance._binanceMetadataBySymbol = new Map();
  let binanceReadyCalls = 0;
  binance.ensureReady = async () => { binanceReadyCalls += 1; };
  const paths = [];
  let releaseBatch;
  const batchGate = new Promise(resolve => { releaseBatch = resolve; });
  binance._binancePublicRequest = async path => {
    paths.push(path);
    await batchGate;
    return exchangeInfo;
  };
  const preload = binance.preloadInstrumentMetadata();
  const normalized = binance.normalizeBinanceUsdmSymbol('AAAUSDT.P');
  const binanceMetadataPromise = binance.getInstrumentMetadata('AAAUSDT.P');
  assert.deepStrictEqual(paths, ['/fapi/v1/exchangeInfo']);
  releaseBatch();
  const [, nativeSymbol, binanceMetadata] = await Promise.all([preload, normalized, binanceMetadataPromise]);
  assert.strictEqual(nativeSymbol, 'AAAUSDT');
  assert.strictEqual(binanceReadyCalls, 0);
  assert.strictEqual(binanceMetadata.tickSize, 0.01);
  assert.strictEqual(binanceMetadata.quantityStep, 0.001);
  assert.strictEqual(binanceMetadata.maxQty, 500);
  await binance.preloadInstrumentMetadata();
  assert.strictEqual(paths.length, 1);

  const retry = Object.create(CCXTExecutionAdapter.prototype);
  retry.exchangeId = 'binance';
  retry._binanceExchangeInfoCache = null;
  retry._binanceExchangeInfoLoadedAt = 0;
  retry._binanceExchangeInfoPromise = null;
  retry._binanceMetadataBySymbol = new Map();
  let retryCalls = 0;
  retry._binancePublicRequest = async () => {
    retryCalls += 1;
    if (retryCalls === 1) throw new Error('temporary failure');
    return exchangeInfo;
  };
  await assert.rejects(() => retry.preloadInstrumentMetadata(), /temporary failure/);
  assert.strictEqual(retry._binanceExchangeInfoPromise, null);
  await retry.preloadInstrumentMetadata();
  assert.strictEqual(retryCalls, 2);

  const simulated = new SimulatedAdapter({ latencyMs: [0, 0] });
  assert.strictEqual((await simulated.getInstrumentMetadata('AAA')).tickSize, 0.01);

  console.log('instrument metadata adapter tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
