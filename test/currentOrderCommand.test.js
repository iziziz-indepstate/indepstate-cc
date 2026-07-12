const assert = require('assert');
const { CurrentOrderCommand } = require('../app/services/commands/currentOrder');

async function run() {
  const queued = [];
  const quotes = [];
  const executionApi = {
    brokerage: {
      getExecutionConfig() {
        return { byInstrumentType: { EQ: 'eq-provider' }, default: 'simulated' };
      },
      getAdapter(provider) {
        assert.strictEqual(provider, 'eq-provider');
        return {
          async getQuote(symbol) {
            quotes.push(symbol);
            return { bid: 99.5, ask: 100.5, price: 100 };
          }
        };
      }
    },
    execution: {
      async queuePlaceOrder(payload) {
        queued.push(payload);
        return { status: 'ok', provider: payload.provider, providerOrderId: 'OID-1' };
      }
    }
  };

  const limit = new CurrentOrderCommand('limit', { executionApi });
  let res = await limit.run(['UPRO', 'buy', '100']);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(quotes, ['UPRO']);
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].symbol, 'UPRO');
  assert.strictEqual(queued[0].side, 'buy');
  assert.strictEqual(queued[0].qty, 100);
  assert.strictEqual(queued[0].type, 'limit');
  assert.strictEqual(queued[0].price, 100.5);
  assert.strictEqual(queued[0].provider, 'eq-provider');
  assert.strictEqual(queued[0].instrumentType, 'EQ');
  assert.strictEqual(queued[0].meta.hedge, true);
  assert.strictEqual(queued[0].meta.retry, false);

  res = await limit.run(['UPRO', 'sell', '50']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(queued[1].side, 'sell');
  assert.strictEqual(queued[1].price, 99.5);

  const market = new CurrentOrderCommand('market', { executionApi });
  res = await market.run(['UPRO', 'sell', '25']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(queued[2].symbol, 'UPRO');
  assert.strictEqual(queued[2].side, 'sell');
  assert.strictEqual(queued[2].qty, 25);
  assert.strictEqual(queued[2].type, 'market');
  assert.strictEqual(queued[2].price, undefined);
  assert.strictEqual(queued[2].meta.hedge, true);
  assert.strictEqual(queued[2].meta.retry, false);
  assert.deepStrictEqual(quotes, ['UPRO', 'UPRO']);

  res = await limit.run(['UPRO', 'hold', '100']);
  assert.strictEqual(res.ok, false);

  console.log('currentOrderCommand tests passed');
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
