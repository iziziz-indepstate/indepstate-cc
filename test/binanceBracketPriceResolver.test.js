const assert = require('assert');
const { CCXTExecutionAdapter } = require('../app/services/brokerage-adapter-ccxt/comps/ccxt');

const adapter = Object.create(CCXTExecutionAdapter.prototype);

(function testLongPoints() {
  const r = adapter._resolveBinanceBracketPrices({ order: { sl: 10, tp: 30 }, direction: 'LONG', entryPrice: 100, tickSize: 0.1 });
  assert.strictEqual(r.stopLossPrice, 99);
  assert.strictEqual(r.takeProfitPrice, 103);
})();

(function testShortPoints() {
  const r = adapter._resolveBinanceBracketPrices({ order: { sl: 10, tp: 30 }, direction: 'SHORT', entryPrice: 100, tickSize: 0.1 });
  assert.strictEqual(r.stopLossPrice, 101);
  assert.strictEqual(r.takeProfitPrice, 97);
})();

(function testAbsolute() {
  const r = adapter._resolveBinanceBracketPrices({ order: { slPrice: 99, tpPrice: 103, sl: 10, tp: 30 }, direction: 'LONG', entryPrice: 100, tickSize: 0.1 });
  assert.strictEqual(r.stopLossPrice, 99);
  assert.strictEqual(r.takeProfitPrice, 103);
  assert.strictEqual(r.source, 'absolute');
})();

(function testMissingTakeProfitIsNotCoercedToEntryPrice() {
  for (const tp of [null, undefined, '', 0, -1, Number.NaN]) {
    const r = adapter._resolveBinanceBracketPrices({ order: { sl: 10, tp }, direction: 'LONG', entryPrice: 100, tickSize: 0.1 });
    assert.strictEqual(r.stopLossPrice, 99);
    assert.strictEqual(r.takeProfitPrice, undefined);
    assert.strictEqual(r.source, 'points');
  }
})();

(function testAbsoluteStopWithoutTakeProfit() {
  const r = adapter._resolveBinanceBracketPrices({ order: { slPrice: 99, tpPrice: '' }, direction: 'LONG', entryPrice: 100, tickSize: 0.1 });
  assert.strictEqual(r.stopLossPrice, 99);
  assert.strictEqual(r.takeProfitPrice, undefined);
  assert.strictEqual(r.source, 'absolute');
})();

(function testStopOnlyOrderUsesManagedBinanceFlow() {
  const a = Object.create(CCXTExecutionAdapter.prototype);
  a._isBinanceUsdmLike = () => true;
  for (const tp of [null, undefined, '', 0, -1, Number.NaN]) {
    assert.strictEqual(a._shouldUseBinanceBracketFlow({ ccxtType: 'limit', order: { sl: 10, tp } }), true);
  }
  assert.strictEqual(a._shouldUseBinanceBracketFlow({ ccxtType: 'limit', order: { sl: 0, tp: null } }), false);
  assert.strictEqual(a._shouldUseBinanceBracketFlow({ ccxtType: 'market', order: { sl: 10, tp: null } }), false);
})();

console.log('binanceBracketPriceResolver.test passed');

(async function testGetQuoteTickSizeFallback() {
  const a = Object.create(CCXTExecutionAdapter.prototype);
  a.exchangeId = 'binanceusdm';
  a._isBinanceUsdmLike = () => true;
  a._getTickSizeFromMarket = () => 1;
  a.normalizeBinanceUsdmSymbol = async () => 'SOMEUSDT';
  a._getBinanceSymbolFilters = async () => ({ tickSize: 0.0001, stepSize: 1, minNotional: 0 });
  const tick = await a._resolveQuoteTickSize('SOME/USDT:USDT', 'SOMEUSDT.P');
  assert.strictEqual(tick, 0.0001);
})();

(function testGetTickSizeFromMarketNoFakeDefault() {
  const a = Object.create(CCXTExecutionAdapter.prototype);
  a.exchange = {
    markets: { 'SOME/USDT:USDT': { info: {} } },
    market: () => ({ info: {} })
  };
  const tick = a._getTickSizeFromMarket('SOME/USDT:USDT');
  assert.strictEqual(tick, undefined);
})();
