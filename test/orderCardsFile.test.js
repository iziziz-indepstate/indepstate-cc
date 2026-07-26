const assert = require('assert');
const { parseLine } = require('../app/services/orderCards/file');

const row = parseLine('mnq.micro 18250 20 40 2');
assert.deepStrictEqual(row, {
  ticker: 'mnq.micro',
  price: 18250,
  sl: 20,
  tp: 40,
  qty: 2
});

const plainTicker = parseLine('ustec 28900');
assert.strictEqual(plainTicker.ticker, 'ustec');

console.log('orderCardsFile tests passed');
