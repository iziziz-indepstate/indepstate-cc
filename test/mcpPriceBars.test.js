const assert = require('assert');
const {
  createGetPriceBarsHandler,
  normalizePriceBarsInput
} = require('../app/services/mcp');

async function run() {
  const fakeBars = [
    {
      time: '2026-06-10T12:00:00.000Z',
      open: 1.1,
      high: 1.2,
      low: 1,
      close: 1.15,
      volume: 10,
      raw: { open: '1.1' }
    }
  ];
  let received;
  const handler = createGetPriceBarsHandler({
    brokerage: {
      getExecutionConfig: () => ({ default: 'dwx', bySymbol: { AAPL: 'j2t' } }),
      getAdapter(provider) {
        assert.strictEqual(provider, 'j2t');
        return {
          async getHistoricBars(args) {
            received = args;
            return fakeBars;
          }
        };
      }
    }
  });

  const result = await handler({
    symbol: 'AAPL',
    timeframe: 'm1',
    from: '2026-06-10T12:00:00.000Z',
    to: '2026-06-10T13:00:00.000Z',
    limit: 100,
    timeoutMs: 1234
  });
  assert.strictEqual(result.provider, 'j2t');
  assert.strictEqual(result.symbol, 'AAPL');
  assert.strictEqual(result.timeframe, 'M1');
  assert.strictEqual(result.count, 1);
  assert.deepStrictEqual(result.bars, fakeBars);
  assert.strictEqual(received.symbol, 'AAPL');
  assert.strictEqual(received.timeframe, 'M1');
  assert.strictEqual(received.limit, 100);
  assert.strictEqual(received.timeoutMs, 1234);
  assert.strictEqual(received.from.toISOString(), '2026-06-10T12:00:00.000Z');
  assert.strictEqual(received.to.toISOString(), '2026-06-10T13:00:00.000Z');

  const normalized = normalizePriceBarsInput(
    {
      provider: 'SIMULATED',
      symbol: ' gbpusd ',
      from: '2026-06-10T00:00:00Z',
      to: '2026-06-10T00:01:00Z',
      limit: 999999
    },
    { getExecutionConfig: () => ({ default: 'dwx', bySymbol: { GBPUSD: 'j2t' } }) }
  );
  assert.strictEqual(normalized.provider, 'simulated');
  assert.strictEqual(normalized.symbol, 'gbpusd');
  assert.strictEqual(normalized.timeframe, 'M1');
  assert.strictEqual(normalized.limit, 5000);

  const symbolResolved = normalizePriceBarsInput(
    {
      symbol: ' gbpusd ',
      from: '2026-06-10T00:00:00Z',
      to: '2026-06-10T00:01:00Z'
    },
    { getExecutionConfig: () => ({ default: 'dwx', bySymbol: { GBPUSD: 'j2t' } }) }
  );
  assert.strictEqual(symbolResolved.provider, 'j2t');

  await assert.rejects(
    () => handler({ from: '2026-06-10T00:00:00Z', to: '2026-06-10T00:01:00Z' }),
    /symbol is required/
  );
  await assert.rejects(
    () => handler({ symbol: 'EURUSD', to: '2026-06-10T00:01:00Z' }),
    /from is required/
  );
  await assert.rejects(
    () => handler({ symbol: 'EURUSD', from: 'nope', to: '2026-06-10T00:01:00Z' }),
    /from must be an ISO date\/time string/
  );
  await assert.rejects(
    () => handler({
      symbol: 'EURUSD',
      from: '2026-06-10T00:02:00Z',
      to: '2026-06-10T00:01:00Z'
    }),
    /to must be greater than or equal to from/
  );

  const unsupported = createGetPriceBarsHandler({
    brokerage: {
      getExecutionConfig: () => ({ default: 'simulated' }),
      getAdapter() { return {}; }
    }
  });
  await assert.rejects(
    () => unsupported({
      symbol: 'EURUSD',
      from: '2026-06-10T00:00:00Z',
      to: '2026-06-10T00:01:00Z'
    }),
    /does not support historic bars/
  );

  console.log('mcp price bars tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
