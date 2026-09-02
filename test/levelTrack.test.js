const assert = require('assert');
const {
  computeActiveLevel,
  createLevelTrackService,
  normalizeConfig,
  pickQuotePrice
} = require('../app/services/levelTrack');

(function testActiveLevelSelection() {
  let res = computeActiveLevel({ levels: [95, 100, 110], maxOffset: 3, price: 101 });
  assert.strictEqual(res.activeLevel, 100);
  assert.strictEqual(res.distance, 1);

  res = computeActiveLevel({ levels: [95, 100, 110], maxOffset: 0.5, price: 101 });
  assert.strictEqual(res.activeLevel, null);
  assert.strictEqual(res.nearestLevel, 100);
  assert.strictEqual(res.reason, 'No active level');

  res = computeActiveLevel({ levels: ['bad', 0], maxOffset: 2, price: 101 });
  assert.strictEqual(res.activeLevel, null);
  assert.strictEqual(res.reason, 'No valid levels');
})();

(function testQuotePricePreference() {
  assert.strictEqual(pickQuotePrice({ price: 10, bid: 9, ask: 11 }), 10);
  assert.strictEqual(pickQuotePrice({ bid: 9, ask: 11 }), 10);
  assert.strictEqual(pickQuotePrice({ bid: 9 }), 9);
  assert.strictEqual(pickQuotePrice({ ask: 11 }), 11);
  assert.strictEqual(pickQuotePrice({}), null);
})();

(function testNormalizeConfig() {
  const cfg = normalizeConfig({
    refreshMs: 2000,
    timeoutMs: 3000,
    groups: [
      { key: 'spx-main', enabled: true, ticker: 'spx.cfd', levels: '7500, 7510 bad', maxOffset: '5' },
      { key: '', ticker: 'BAD', levels: [1], maxOffset: 1 }
    ]
  });
  assert.strictEqual(cfg.refreshMs, 2000);
  assert.strictEqual(cfg.timeoutMs, 3000);
  assert.strictEqual(cfg.groups.length, 1);
  assert.strictEqual(cfg.groups[0].ticker, 'spx.cfd');
  assert.deepStrictEqual(cfg.groups[0].levels, [7500, 7510]);
})();

async function testServiceResolverUsesFreshQuote() {
  const calls = [];
  const service = createLevelTrackService({
    config: {
      groups: [
        { key: 'spx-main', enabled: true, ticker: 'SPX', levels: [7500, 7510], maxOffset: 3 }
      ]
    },
    instrumentInfo: {
      async get(context, options) {
        calls.push({ context, options });
        return { provider: 'simulated', symbol: 'SPX', quote: { bid: 7508, ask: 7510 } };
      }
    },
    clock: () => 123
  });

  const res = await service.resolveLevel({ key: 'spx-main', ticker: 'SPX' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.level, 7510);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.forceQuote, true);
  const state = service.getState('spx-main');
  assert.strictEqual(state.status, 'active');
  assert.strictEqual(state.price, 7509);
  assert.strictEqual(state.activeLevel, 7510);

  const mismatch = await service.resolveLevel({ key: 'spx-main', ticker: 'NDX' });
  assert.strictEqual(mismatch.ok, false);
  assert.strictEqual(mismatch.error, 'LevelTrack group spx-main tracks SPX, not NDX');
}

async function testServiceSave() {
  let saved;
  const service = createLevelTrackService({
    config: { groups: [] },
    saveConfig: async config => {
      saved = config;
      return { saved: true, config };
    }
  });
  const res = await service.save({
    groups: [{ key: 'mnq', enabled: true, ticker: 'mnq', levels: [100], maxOffset: 1 }]
  });
  assert.strictEqual(res.saved, true);
  assert.strictEqual(saved.groups[0].ticker, 'mnq');
  assert.strictEqual(service.getGroup('mnq').ticker, 'mnq');
}

async function testNearestTrackedLevelProvider() {
  const service = createLevelTrackService({
    config: {
      groups: [
        { key: 'far', enabled: true, ticker: 'SPX', levels: [100], maxOffset: 10 },
        { key: 'near', enabled: true, ticker: 'spx', levels: [104], maxOffset: 10 },
        { key: 'disabled', enabled: false, ticker: 'SPX', levels: [105], maxOffset: 10 },
        { key: 'other', enabled: true, ticker: 'NDX', levels: [106], maxOffset: 10 }
      ]
    },
    instrumentInfo: {
      async get(context) {
        assert.strictEqual(String(context.ticker).toUpperCase(), 'SPX');
        return { provider: 'simulated', quote: { bid: 102, ask: 104 } };
      }
    }
  });

  const res = await service.resolveNearestTrackedLevel({ ticker: 'SPX', placeholder: 'nearestTrackedLevel' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.level, 104);
  assert.strictEqual(res.source.key, 'near');
  assert.strictEqual(res.source.distance, 1);
}

async function testNearestTrackedLevelNoActive() {
  const service = createLevelTrackService({
    config: {
      groups: [
        { key: 'spx-main', enabled: true, ticker: 'SPX', levels: [100], maxOffset: 1 }
      ]
    },
    instrumentInfo: {
      async get() {
        return { provider: 'simulated', quote: { bid: 109, ask: 111 } };
      }
    }
  });

  const res = await service.resolveNearestTrackedLevel({ ticker: 'SPX', placeholder: 'nearestTrackedLevel' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /No active LevelTrack level for SPX/);
  assert.strictEqual(res.source.candidates[0].key, 'spx-main');
  assert.strictEqual(res.source.candidates[0].nearestLevel, 100);
}

async function testNearestTrackedLevelNoGroups() {
  const service = createLevelTrackService({
    config: { groups: [{ key: 'ndx', enabled: true, ticker: 'NDX', levels: [100], maxOffset: 1 }] }
  });

  const res = await service.resolveNearestTrackedLevel({ ticker: 'SPX', placeholder: 'nearestTrackedLevel' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'No LevelTrack groups for SPX');
}

async function run() {
  await testServiceResolverUsesFreshQuote();
  await testServiceSave();
  await testNearestTrackedLevelProvider();
  await testNearestTrackedLevelNoActive();
  await testNearestTrackedLevelNoGroups();
  console.log('levelTrack tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
