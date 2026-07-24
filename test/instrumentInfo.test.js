const assert = require('assert');
const { createInstrumentInfoService } = require('../app/services/instrumentInfo');

async function run() {
  let now = 1000;
  let quoteCalls = 0;
  let metadataCalls = 0;
  const forgotten = [];
  const adapters = {
    one: {
      async getQuote(symbol) {
        quoteCalls += 1;
        return { bid: 10, ask: 12, tickSize: 0.25, tickSource: 'provider-spec', timestamp: now, symbol };
      },
      async getInstrumentMetadata() {
        metadataCalls += 1;
        return { tickSize: 0.25, quantityStep: 0.5, minQty: 1, maxQty: 20, minNotional: 5, contractSize: 10 };
      },
      async forgetQuote(symbol) { forgotten.push(symbol); }
    },
    two: {
      async getQuote() { return { bid: 20, ask: 22 }; }
    },
    failing: {
      async getQuote() { throw new Error('quote unavailable'); },
      async getInstrumentMetadata() { return null; }
    }
  };
  const brokerage = {
    getAdapter(provider) { return adapters[provider]; },
    resolveProvider(context) { return { provider: context.provider || 'one' }; }
  };
  const updates = [];
  const service = createInstrumentInfoService({ brokerage, clock: () => now });
  service.on('updated', snapshot => updates.push(snapshot));

  const [first, duplicate] = await Promise.all([
    service.get({ provider: 'one', symbol: 'aaa' }),
    service.get({ provider: 'one', symbol: 'AAA' })
  ]);
  assert.strictEqual(quoteCalls, 1);
  assert.strictEqual(metadataCalls, 1);
  assert.deepStrictEqual(first.quote, { bid: 10, ask: 12, price: 11, timestamp: 1000 });
  assert.strictEqual(duplicate.metadata.quantityStep, 0.5);
  assert.ok(first.sources.tickSize.startsWith('adapter:one'));
  assert.ok(updates.length >= 1);

  await service.get({ provider: 'one', symbol: 'AAA' });
  assert.strictEqual(quoteCalls, 1);
  await service.get({ provider: 'one', symbol: 'AAA' }, { forceQuote: true });
  assert.strictEqual(quoteCalls, 2);
  now += 1001;
  await service.get({ provider: 'one', symbol: 'AAA' });
  assert.strictEqual(quoteCalls, 3);
  assert.strictEqual(metadataCalls, 1);
  now += 5 * 60 * 1000;
  await service.get({ provider: 'one', symbol: 'AAA' }, { quote: false });
  assert.strictEqual(metadataCalls, 2);

  const otherProvider = await service.get({ provider: 'two', symbol: 'AAA' });
  assert.strictEqual(otherProvider.quote.price, 21);
  assert.notStrictEqual(service.peek({ provider: 'one', symbol: 'AAA' }).quote.price, otherProvider.quote.price);

  assert.strictEqual(service.resolveTickSize({ provider: 'one', symbol: 'AAA' }, { explicitTickSize: 0.125 }), 0.125);
  const brokerResolution = service.getTickSizeResolution({ provider: 'one', symbol: 'AAA' });
  assert.strictEqual(brokerResolution.tickSize, 0.25);
  assert.ok(brokerResolution.source.startsWith('adapter:one'));
  assert.strictEqual(service.toPoints({ provider: 'one', symbol: 'AAA' }, 0.5), 2);
  assert.strictEqual(service.toPoints({ provider: 'one', symbol: 'AAA' }, 0.1), 0);

  const configured = await service.get({ provider: 'two', symbol: 'MOVRUSDT.P' }, { quote: false });
  assert.strictEqual(configured.metadata.tickSize, 0.0001);
  assert.strictEqual(configured.sources.tickSize, 'config:tick-sizes');

  const failed = await service.get({ provider: 'failing', symbol: 'UNKNOWN' });
  assert.strictEqual(failed.metadata.tickSize, 0.01);
  assert.strictEqual(failed.sources.tickSize, 'config:defaultTickSize');

  assert.strictEqual(await service.forget({ provider: 'one', symbol: 'AAA' }), true);
  assert.deepStrictEqual(forgotten, ['AAA']);
  assert.deepStrictEqual(service.peek({ provider: 'one', symbol: 'AAA' }).quote, {});

  console.log('instrumentInfo tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
