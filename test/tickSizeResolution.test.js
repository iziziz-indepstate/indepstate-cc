const assert = require('assert');
const orderCalc = require('../app/services/orderCalculator');
const { resolveTickSize } = require('../app/services/instrumentInfo/points');

function run() {
  assert.strictEqual(resolveTickSize({ symbol: 'UNKNOWNUSDT.P' }), 0.01);

  assert.strictEqual(resolveTickSize({ symbol: 'MOVRUSDT.P' }), 0.0001);

  assert.strictEqual(resolveTickSize({
    symbol: 'BNBUSDT.P',
    quoteTickSize: 0.01,
    quoteTickSource: 'binance-exchangeInfo'
  }), 0.01);

  assert.strictEqual(resolveTickSize({
    symbol: 'MOVRUSDT.P',
    quoteTickSize: 0.01
  }), 0.0001);

  const qty = orderCalc.qty({
    riskUsd: 15,
    stopPts: 35,
    tickSize: resolveTickSize({ symbol: 'UNKNOWNUSDT.P' }),
    lot: 1,
    instrumentType: 'CX'
  });

  assert.strictEqual(qty, 42.857);
}

run();
console.log('tickSizeResolution tests passed');
