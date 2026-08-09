const assert = require('assert');
const { createOrderCardsApplicationService } = require('../app/services/orderCards');

async function run() {
  {
    const positionCommands = [];
    const published = [];
    const service = createOrderCardsApplicationService({
      positions: { handle: cmd => positionCommands.push(cmd) },
      resolveProviderName: ({ instrumentType }) => instrumentType === 'CX' ? 'ccxt:binance' : 'simulated',
      publish: (channel, payload) => published.push({ channel, payload })
    });

    const row = service.ingestRow({ symbol: 'BTCUSDT.P', event: 'up', time: 2 }, { source: 'webhook' });
    assert.strictEqual(row.ticker, 'BTCUSDT.P');
    assert.strictEqual(row.symbol, 'BTCUSDT.P');
    assert.strictEqual(row.instrumentType, 'CX');
    assert.strictEqual(row.provider, 'ccxt:binance');
    assert.strictEqual(positionCommands.length, 1);
    assert.strictEqual(positionCommands[0].ticker, 'BTCUSDT.P');
    assert.strictEqual(positionCommands[0].provider, 'ccxt:binance');
    assert.deepStrictEqual(published.map(item => item.channel), ['order-cards:changed']);
    assert.strictEqual(published[0].payload.type, 'upsert');
    assert.strictEqual(published[0].payload.row.ticker, 'BTCUSDT.P');
    assert.strictEqual(published[0].payload.source, 'webhook');
    assert.ok(published[0].payload.eventId);
  }

  {
    const positionCommands = [];
    const published = [];
    const service = createOrderCardsApplicationService({
      positions: { handle: cmd => positionCommands.push(cmd) },
      publish: (channel, payload) => published.push({ channel, payload })
    });

    const row = service.ingestRow({ cardType: 'legacyExtension', ticker: 'AAPL', event: 'custom', time: 1 }, { source: 'webhook' });
    assert.strictEqual(row.cardType, 'legacyExtension');
    assert.strictEqual(positionCommands.length, 0);
    assert.deepStrictEqual(published.map(item => item.channel), ['order-cards:changed']);
    assert.strictEqual(published[0].payload.type, 'upsert');
    assert.strictEqual(published[0].payload.source, 'webhook');
    assert.ok(published[0].payload.eventId);
  }

  {
    const published = [];
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const service = createOrderCardsApplicationService({
        positions: { handle: () => ({ ok: false, error: 'invalid position' }) },
        publish: (channel, payload) => published.push({ channel, payload })
      });
      const result = service.ingestRow({ ticker: 'MSFT', event: 'up', time: 3 });
      assert.deepStrictEqual(result, { ok: false, error: 'invalid position' });
      assert.deepStrictEqual(published, []);
      assert(warnings.some(line => line.includes('invalid position')));
    } finally {
      console.warn = originalWarn;
    }
  }

  {
    const published = [];
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const service = createOrderCardsApplicationService({
        positions: { handle: () => { throw new Error('boom'); } },
        publish: (channel, payload) => published.push({ channel, payload })
      });
      const result = service.ingestRow({ ticker: 'NVDA', event: 'up', time: 4 });
      assert.deepStrictEqual(result, { ok: false, error: 'boom' });
      assert.deepStrictEqual(published, []);
      assert(warnings.some(line => line.includes('boom')));
      assert.deepStrictEqual(await service.list({ rows: 10 }), []);
    } finally {
      console.warn = originalWarn;
    }
  }

  {
    const published = [];
    const service = createOrderCardsApplicationService({
      publish: (channel, payload) => published.push({ channel, payload })
    });
    service.ingestRow({ cardType: 'legacyExtension', ticker: 'AAPL', producingLineId: 'line-1', time: 1 });
    const result = service.remove({ producingLineId: 'line-1' });
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(published.slice(-1).map(item => item.channel), ['order-cards:changed']);
    assert.strictEqual(published[published.length - 1].payload.type, 'remove');
    assert.ok(published[published.length - 1].payload.eventId);
    assert.strictEqual(published[published.length - 1].payload.filter.producingLineId, 'line-1');
  }

  {
    const sourceService = {
      getOrdersList: async () => [
        { ticker: 'MSFT', time: 3 },
        { ticker: 'AAPL', time: 1, provider: 'manual' }
      ]
    };
    const service = createOrderCardsApplicationService({
      getSourceServices: () => [sourceService],
      positions: { handle: () => ({ ok: true }) },
      resolveProviderName: ({ row }) => row.provider || 'simulated'
    });
    service.ingestRow({ ticker: 'TSLA', time: 2 });
    const rows = await service.list({ rows: 10 });
    assert.deepStrictEqual(rows.map(row => row.ticker), ['MSFT', 'TSLA', 'AAPL']);
    assert.deepStrictEqual(rows.map(row => row.instrumentType), ['EQ', 'EQ', 'EQ']);
    assert.deepStrictEqual(rows.map(row => row.provider), ['simulated', 'simulated', 'manual']);
  }

  console.log('orderCardsApplicationService tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
