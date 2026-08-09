const assert = require('assert');
const { createOrderCardsApplicationService } = require('../app/services/orderCards');

async function run() {
  {
    const positionCommands = [];
    const published = [];
    const service = createOrderCardsApplicationService({
      positions: { handle: cmd => positionCommands.push(cmd) },
      resolveProviderName: ({ instrumentType }) => instrumentType === 'CX' ? 'ccxt:binance' : 'simulated',
      publish: (channel, payload) => published.push({ channel, payload }),
      legacyPublish: (channel, payload) => published.push({ channel, payload, legacy: true })
    });

    const row = service.ingestRow({ symbol: 'BTCUSDT.P', event: 'up', time: 2 }, { source: 'webhook' });
    assert.strictEqual(row.ticker, 'BTCUSDT.P');
    assert.strictEqual(row.symbol, 'BTCUSDT.P');
    assert.strictEqual(row.instrumentType, 'CX');
    assert.strictEqual(row.provider, 'ccxt:binance');
    assert.strictEqual(positionCommands.length, 1);
    assert.strictEqual(positionCommands[0].ticker, 'BTCUSDT.P');
    assert.strictEqual(positionCommands[0].provider, 'ccxt:binance');
    assert.deepStrictEqual(published.map(item => item.channel), ['order-cards:changed', 'orders:new']);
    assert.strictEqual(published[0].payload.type, 'upsert');
    assert.strictEqual(published[0].payload.source, 'webhook');
    assert.ok(published[0].payload.eventId);
    assert.strictEqual(published[1].payload.__orderCardsEventId, published[0].payload.eventId);
    assert.strictEqual(published[1].payload.ticker, 'BTCUSDT.P');
  }

  {
    const published = [];
    const service = createOrderCardsApplicationService({
      publish: (channel, payload) => published.push({ channel, payload }),
      legacyPublish: (channel, payload) => published.push({ channel, payload, legacy: true })
    });
    service.ingestRow({ ticker: 'AAPL', producingLineId: 'line-1', time: 1 });
    const result = service.remove({ producingLineId: 'line-1' });
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(published.slice(-2).map(item => item.channel), ['order-cards:changed', 'orders:remove']);
    assert.strictEqual(published[published.length - 2].payload.type, 'remove');
    assert.ok(published[published.length - 2].payload.eventId);
    assert.strictEqual(
      published[published.length - 1].payload.__orderCardsEventId,
      published[published.length - 2].payload.eventId
    );
    assert.strictEqual(published[published.length - 1].payload.producingLineId, 'line-1');
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
