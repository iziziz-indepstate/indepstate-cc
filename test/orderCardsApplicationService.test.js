const assert = require('assert');
const { createOrderCardsApplicationService } = require('../app/services/orderCards');

async function run() {
  {
    const cases = [
      { cardType: 'regular', shouldCreateSnapshot: true },
      { cardType: 'levelOrder', shouldCreateSnapshot: true },
      { cardType: 'option', shouldCreateSnapshot: true },
      { cardType: 'optionstrat', shouldCreateSnapshot: true },
      { cardType: 'unknownCard', shouldCreateSnapshot: true }
    ];
    for (const item of cases) {
      const positionInputs = [];
      const published = [];
      const service = createOrderCardsApplicationService({
        positions: {
          createFromInput(row, context) {
            positionInputs.push({ row, context });
            return {
              ok: true,
              position: {
                id: `pos-${item.cardType}`,
                ticker: row.ticker,
                card: { type: row.cardType || 'regular' }
              }
            };
          }
        },
        publish: (channel, payload) => published.push({ channel, payload })
      });
      const result = service.ingestRow({
        cardType: item.cardType,
        ticker: `TST-${item.cardType}`,
        event: item.cardType,
        time: 1
      }, { source: 'routing-test' });
      assert.strictEqual(positionInputs.length, 1, `${item.cardType} snapshot routing`);
      assert.strictEqual(published.length, 1, `${item.cardType} published row`);
      assert.strictEqual(published[0].channel, 'order-cards:changed');
      assert.strictEqual(published[0].payload.type, 'upsert');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.position.card.type, item.cardType);
      assert.strictEqual(positionInputs[0].row.cardType, item.cardType);
      assert.deepStrictEqual(positionInputs[0].context, { source: 'routing-test' });
    }
  }

  {
    const positionInputs = [];
    const published = [];
    const service = createOrderCardsApplicationService({
      positions: { createFromInput: (row, context) => positionInputs.push({ row, context }) },
      resolveProviderName: ({ instrumentType }) => instrumentType === 'CX' ? 'ccxt:binance' : 'simulated',
      publish: (channel, payload) => published.push({ channel, payload })
    });

    const row = service.ingestRow({ symbol: 'BTCUSDT.P', event: 'up', time: 2 }, { source: 'webhook' });
    assert.strictEqual(row.ticker, 'BTCUSDT.P');
    assert.strictEqual(row.symbol, 'BTCUSDT.P');
    assert.strictEqual(row.instrumentType, 'CX');
    assert.strictEqual(row.provider, 'ccxt:binance');
    assert.strictEqual(positionInputs.length, 1);
    assert.strictEqual(positionInputs[0].row.ticker, 'BTCUSDT.P');
    assert.strictEqual(positionInputs[0].row.provider, 'ccxt:binance');
    assert.deepStrictEqual(positionInputs[0].context, { source: 'webhook' });
    assert.deepStrictEqual(published.map(item => item.channel), ['order-cards:changed']);
    assert.strictEqual(published[0].payload.type, 'upsert');
    assert.strictEqual(published[0].payload.row.ticker, 'BTCUSDT.P');
    assert.strictEqual(published[0].payload.source, 'webhook');
    assert.ok(published[0].payload.eventId);
  }

  {
    const positionInputs = [];
    const service = createOrderCardsApplicationService({
      positions: { createFromInput: row => positionInputs.push(row) },
      resolveProviderName: () => 'simulated'
    });

    const row = service.ingestRow({
      cardType: 'option',
      ticker: 'SPY',
      event: 'optionstrat',
      provider: 'optionstrat',
      instrumentType: 'OPT',
      time: 5
    }, { source: 'commandLine' });
    assert.strictEqual(row.provider, 'optionstrat');
    assert.strictEqual(positionInputs[0].provider, 'optionstrat');
    assert.strictEqual(positionInputs[0].cardType, 'option');
  }

  {
    const positionInputs = [];
    const published = [];
    const service = createOrderCardsApplicationService({
      positions: { createFromInput: row => positionInputs.push(row) },
      publish: (channel, payload) => published.push({ channel, payload })
    });

    const row = service.ingestRow({ cardType: 'unregisteredRenderer', ticker: 'AAPL', event: 'custom', time: 1 }, { source: 'webhook' });
    assert.strictEqual(row.cardType, 'unregisteredRenderer');
    assert.strictEqual(positionInputs.length, 1);
    assert.strictEqual(positionInputs[0].cardType, 'unregisteredRenderer');
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
        positions: { createFromInput: () => ({ ok: false, error: 'invalid position' }) },
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
        positions: { createFromInput: () => { throw new Error('boom'); } },
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
      positions: { createFromInput: () => ({ ok: true }) },
      publish: (channel, payload) => published.push({ channel, payload })
    });
    service.ingestRow({ cardType: 'unregisteredRenderer', ticker: 'AAPL', producingLineId: 'line-1', time: 1 });
    const result = service.remove({ producingLineId: 'line-1' });
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(published.slice(-1).map(item => item.channel), ['order-cards:changed']);
    assert.strictEqual(published[published.length - 1].payload.type, 'remove');
    assert.ok(published[published.length - 1].payload.eventId);
    assert.strictEqual(published[published.length - 1].payload.filter.producingLineId, 'line-1');
  }

  {
    const sourceCalls = [];
    const sourceService = {
      list: async (request) => {
        sourceCalls.push(request);
        return [
          { ticker: 'MSFT', time: 3 },
          { ticker: 'AAPL', time: 1, provider: 'manual' }
        ];
      }
    };
    const service = createOrderCardsApplicationService({
      getSourceServices: () => [sourceService],
      positions: { createFromInput: () => ({ ok: true }) },
      resolveProviderName: ({ row }) => row.provider || 'simulated'
    });
    service.ingestRow({ ticker: 'TSLA', time: 2 });
    const rows = await service.list({ rows: 10 });
    assert.deepStrictEqual(sourceCalls, [{ rows: 10 }]);
    assert.deepStrictEqual(rows.map(row => row.ticker), ['MSFT', 'TSLA', 'AAPL']);
    assert.deepStrictEqual(rows.map(row => row.instrumentType), ['EQ', 'EQ', 'EQ']);
    assert.deepStrictEqual(rows.map(row => row.provider), ['simulated', 'simulated', 'manual']);
    await assert.rejects(
      () => service.list({ source: 'executions', rows: 10 }),
      /Unknown order-cards source: executions/
    );
  }

  console.log('orderCardsApplicationService tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
