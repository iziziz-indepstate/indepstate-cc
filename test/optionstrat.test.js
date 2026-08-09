const assert = require('assert');
const zlib = require('zlib');
const {
  OptionStratAdapter,
  decodeOptionStratProtected,
  normalizeOptionChain,
  resolveExpirationByDte,
  buildOptionSymbol,
  calculatePayoffSummary,
  calculateStrategyValuation,
  buildOpenStrategyPayload
} = require('../app/services/optionstrat/infrastructure/adapter');
const { OptionStratCommand, buildOptionStratRow } = require('../app/services/optionstrat/command');
const { buildOptionStratHedgePayload } = require('../app/services/optionstrat/hedge');

function encodeProtectedJson(obj) {
  const xorKey = 7;
  const fixIndex = 3;
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  plain[fixIndex] ^= xorKey;
  const compressed = Buffer.from(zlib.deflateRawSync(plain));
  for (let i = 0; i < compressed.length; i += 1) {
    compressed[i] ^= i % xorKey;
  }
  return Buffer.concat([Buffer.from([fixIndex, xorKey]), compressed]);
}

function response(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: { get: () => null },
    text: async () => JSON.stringify(json),
    buffer: async () => Buffer.from(JSON.stringify(json))
  };
}

function chainSample() {
  return {
    context: {
      i: {
        c: {
          SPY: [
            {
              exp: '260531',
              ua: '2026-05-31T20:00:00Z',
              s: {
                755: { c: { b: 2, a: 2.2, v: 1, o: 2, p: 2.1 } },
                756: { c: { b: 1, a: 1.4, v: 1, o: 2, p: 1.2 } }
              }
            },
            {
              exp: '260601',
              ua: '2026-06-01T20:00:00Z',
              s: {
                755: { c: { b: 3, a: 3.2, v: 1, o: 2, p: 3.1 } }
              }
            }
          ]
        }
      }
    }
  };
}

function rootChainSample() {
  return {
    context: {
      i: {
        c: {
          SPX: [
            {
              exp: '260531',
              ua: '2026-05-31T20:00:00Z',
              s: {
                755: { c: { b: 4, a: 4.2, v: 1, o: 2, p: 4.1 } },
                756: { c: { b: 2, a: 2.4, v: 1, o: 2, p: 2.2 } }
              }
            }
          ]
        }
      }
    }
  };
}

function rootCloseChainSample() {
  return {
    context: {
      i: {
        c: {
          SPX: [
            {
              exp: '260531',
              ua: '2026-05-31T20:00:00Z',
              s: {
                755: { c: { b: 4.4, a: 4.6, v: 1, o: 2, p: 4.5 } },
                756: { c: { b: 1.9, a: 2.1, v: 1, o: 2, p: 2.0 } }
              }
            }
          ]
        }
      }
    }
  };
}

async function run() {
  const protectedObj = { ok: true, value: 42 };
  assert.deepStrictEqual(JSON.parse(decodeOptionStratProtected(encodeProtectedJson(protectedObj)).toString('utf8')), protectedObj);

  const rows = normalizeOptionChain(chainSample(), 'SPY');
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(resolveExpirationByDte(chainSample(), 'SPY', '0DTE', new Date(Date.UTC(2026, 4, 31))), '260531');
  assert.strictEqual(resolveExpirationByDte(chainSample(), 'SPY', '1DTE', new Date(Date.UTC(2026, 4, 31))), '260601');
  assert.strictEqual(buildOptionSymbol('spy', '260531', 'CALL', 755), '.SPY260531C755');

  const bcsPayoff = calculatePayoffSummary([
    { option: 'CALL', strike: 755, basis: 2.1, quantity: 10 },
    { option: 'CALL', strike: 756, basis: 1.2, quantity: -10 }
  ]);
  assert.deepStrictEqual(bcsPayoff, {
    maxProfit: 100,
    maxLoss: 900,
    isMaxProfitInfinite: false,
    isMaxLossInfinite: false,
    multiplier: 100
  });

  const longCallPayoff = calculatePayoffSummary([
    { option: 'CALL', strike: 755, basis: 2.1, quantity: 1 }
  ]);
  assert.strictEqual(longCallPayoff.maxLoss, 210);
  assert.strictEqual(longCallPayoff.isMaxProfitInfinite, true);

  const shortCallPayoff = calculatePayoffSummary([
    { option: 'CALL', strike: 755, basis: 2.1, quantity: -1 }
  ]);
  assert.strictEqual(shortCallPayoff.maxProfit, 210);
  assert.strictEqual(shortCallPayoff.isMaxLossInfinite, true);

  const mixedPayoff = calculatePayoffSummary([
    { option: 'PUT', strike: 750, basis: 1, quantity: 2 },
    { option: 'CALL', strike: 760, basis: 1.5, quantity: -1 }
  ]);
  assert.strictEqual(mixedPayoff.isMaxProfitInfinite, false);
  assert.strictEqual(mixedPayoff.isMaxLossInfinite, true);

  const openPayload = buildOpenStrategyPayload({
    ticker: 'SPY',
    name: 'BCS 755/756',
    legs: [
      { option: 'CALL', side: 'buy', strike: 755, quantity: 10 },
      { option: 'CALL', side: 'sell', strike: 756, quantity: 10 }
    ]
  }, '260531', rows, 'acct-1');
  assert.deepStrictEqual(openPayload.strategy.items.map(i => [i.symbol, i.basis, i.quantity]), [
    ['.SPY260531C755', 2.1, 10],
    ['.SPY260531C756', 1.2, -10]
  ]);
  const valuationRows = normalizeOptionChain({
    context: {
      i: {
        c: {
          SPY: [{
            exp: '260531',
            ua: '2026-05-31T20:00:00Z',
            s: {
              755: { c: { b: 2.5, a: 2.7 } },
              756: { c: { b: 1.1, a: 1.3 } }
            }
          }]
        }
      }
    }
  }, 'SPY');
  const valuation = calculateStrategyValuation(openPayload.strategy, valuationRows);
  assert.strictEqual(valuation.initialValue, 900);
  assert.strictEqual(valuation.currentValue, 1400);
  assert.strictEqual(valuation.change, 500);
  assert.strictEqual(valuation.changePct, 55.56);

  const built = buildOptionStratRow({
    command: 'bcs {s1} {s2} {q}',
    name: 'BCS {s1}/{s2}',
    ticker: 'SPXW',
    root: 'SPX',
    expiration: '0DTE',
    instantExecution: true,
    legs: [
      { option: 'CALL', side: 'buy', strike: '{s1}', quantity: '{q}' },
      { option: 'CALL', side: 'sell', strike: '{s2}', quantity: '{q}' }
    ]
  }, ['755', '756', '10'], 123);
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.row.cardType, 'option');
  assert.strictEqual(built.row.instrumentType, 'OPT');
  assert.strictEqual(built.row.name, 'BCS 755/756');
  assert.strictEqual(built.row.ticker, 'SPXW');
  assert.strictEqual(built.row.root, 'SPX');
  assert.strictEqual(built.row.instantExecution, true);
  assert.strictEqual(built.row.strategyCommand, 'bcs');
  assert.strictEqual(built.row.legs[1].side, 'sell');
  assert.strictEqual(built.row.legs[1].quantity, 10);

  const commandDefinition = {
    command: 'bcs {s1} {s2} {q}',
    name: 'BCS {s1}/{s2}',
    ticker: 'SPY',
    legs: [
      { option: 'CALL', side: 'buy', strike: '{s1}', quantity: '{q}' },
      { option: 'CALL', side: 'sell', strike: '{s2}', quantity: '{q}' }
    ]
  };
  const missingAdd = new OptionStratCommand(commandDefinition, { now: () => 130 });
  assert.deepStrictEqual(missingAdd.run(['755', '756', '1']), {
    ok: false,
    error: 'Order add handler unavailable'
  });

  const syncAdd = new OptionStratCommand(commandDefinition, {
    now: () => 131,
    onAdd: row => ({ ok: true, ticker: row.ticker, cardType: row.cardType })
  });
  assert.deepStrictEqual(syncAdd.run(['755', '756', '1']), {
    ok: true,
    ticker: 'SPY',
    cardType: 'option'
  });

  const asyncAdd = new OptionStratCommand(commandDefinition, {
    now: () => 132,
    onAdd: async row => ({ ok: true, position: { ticker: row.ticker, card: { type: row.cardType } } })
  });
  const asyncAddResult = await asyncAdd.run(['755', '756', '1']);
  assert.strictEqual(asyncAddResult.ok, true);
  assert.strictEqual(asyncAddResult.position.card.type, 'option');

  const lcsHedge = buildOptionStratHedgePayload('open', { strategyCommand: 'lcs', ticker: 'SPY', provider: 'optionstrat' });
  assert.strictEqual(lcsHedge.eventName, 'optionstrat:open-clicked');
  assert.strictEqual(lcsHedge.payload.hedgeOpenSide, 'buy');
  assert.strictEqual(lcsHedge.payload.hedgeCloseSide, 'sell');
  assert.strictEqual(lcsHedge.payload.hedgeSymbol, 'UPRO');

  const spsHedge = buildOptionStratHedgePayload('close', { strategyCommand: 'sps', ticker: 'SPY', provider: 'optionstrat' });
  assert.strictEqual(spsHedge.eventName, 'optionstrat:close-clicked');
  assert.strictEqual(spsHedge.payload.hedgeOpenSide, 'sell');
  assert.strictEqual(spsHedge.payload.hedgeCloseSide, 'buy');

  const builtDefaultQtyFromMissingArg = buildOptionStratRow({
    command: 'bcs {s1} {s2} {q}',
    name: 'BCS {s1}/{s2}',
    ticker: 'SPY',
    legs: [
      { option: 'CALL', side: 'buy', strike: '{s1}', quantity: '{q}' },
      { option: 'CALL', side: 'sell', strike: '{s2}', quantity: '{q}' }
    ]
  }, ['755', '756'], 124);
  assert.strictEqual(builtDefaultQtyFromMissingArg.ok, true);
  assert.strictEqual(builtDefaultQtyFromMissingArg.row.legs[0].quantity, 1);
  assert.strictEqual(builtDefaultQtyFromMissingArg.row.legs[1].quantity, 1);

  const builtDefaultQtyWithoutPlaceholder = buildOptionStratRow({
    command: 'bcs {s1} {s2}',
    name: 'BCS {s1}/{s2}',
    ticker: 'SPY',
    legs: [
      { option: 'CALL', side: 'buy', strike: '{s1}', quantity: '{q}' },
      { option: 'CALL', side: 'sell', strike: '{s2}', quantity: '{q}' }
    ]
  }, ['755', '756'], 125);
  assert.strictEqual(builtDefaultQtyWithoutPlaceholder.ok, true);
  assert.strictEqual(builtDefaultQtyWithoutPlaceholder.row.legs[0].quantity, 1);
  assert.strictEqual(builtDefaultQtyWithoutPlaceholder.row.legs[1].quantity, 1);

  const builtSortedStrikes = buildOptionStratRow({
    command: 'bcs {s1} {s2} {q}',
    name: 'BCS {min}/{max}',
    ticker: 'SPY',
    legs: [
      { option: 'CALL', side: 'buy', strike: '{min}', quantity: '{q}' },
      { option: 'CALL', side: 'sell', strike: '{max}', quantity: '{q}' }
    ]
  }, ['756', '755', '10'], 126);
  assert.strictEqual(builtSortedStrikes.ok, true);
  assert.strictEqual(builtSortedStrikes.row.name, 'BCS 755/756');
  assert.strictEqual(builtSortedStrikes.row.legs[0].strike, 755);
  assert.strictEqual(builtSortedStrikes.row.legs[1].strike, 756);
  assert.strictEqual(builtSortedStrikes.row.legs[0].quantity, 10);

  const builtRangeAliasesAsCommandArgs = buildOptionStratRow({
    command: 'bcs {max} {min}',
    name: 'BCS {min}/{max}',
    ticker: 'SPY',
    legs: [
      { option: 'CALL', side: 'buy', strike: '{min}', quantity: '{q}' },
      { option: 'CALL', side: 'sell', strike: '{max}', quantity: '{q}' }
    ]
  }, ['756', '755'], 127);
  assert.strictEqual(builtRangeAliasesAsCommandArgs.ok, true);
  assert.strictEqual(builtRangeAliasesAsCommandArgs.row.name, 'BCS 755/756');
  assert.strictEqual(builtRangeAliasesAsCommandArgs.row.legs[0].strike, 755);
  assert.strictEqual(builtRangeAliasesAsCommandArgs.row.legs[1].strike, 756);

  const noRootCalls = [];
  const noRootAdapter = new OptionStratAdapter({
    account: 'acct-1',
    cookie: 'session=abc',
    useRuntimeSettings: false,
    now: () => new Date(Date.UTC(2026, 4, 31)),
    fetch: async (url, opts = {}) => {
      noRootCalls.push({ url, opts });
      assert.strictEqual(opts.headers.Cookie, 'session=abc');
      if (url.endsWith('/quote/chain/live/SPY')) return response(chainSample());
      if (url.endsWith('/strategy') && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.strategy.symbol, 'SPY');
        assert.strictEqual(body.strategy.items[0].symbol, '.SPY260531C755');
        return response({ ...body, code: 'deal-no-root', account: 'acct-1' });
      }
      throw new Error(`Unexpected no-root request ${url}`);
    }
  }, 'optionstrat');

  const noRootEstimate = await noRootAdapter.estimateOrder({
    instrumentType: 'OPT',
    ticker: 'SPY',
    name: 'BCS 755/756',
    expirationDte: '0DTE',
    legs: [
      { option: 'CALL', side: 'buy', strike: 755, quantity: 10 },
      { option: 'CALL', side: 'sell', strike: 756, quantity: 10 }
    ]
  });
  assert.strictEqual(noRootEstimate.status, 'ok');
  assert.deepStrictEqual(noRootEstimate.payoff, {
    maxProfit: 100,
    maxLoss: 900,
    isMaxProfitInfinite: false,
    isMaxLossInfinite: false,
    multiplier: 100
  });

  const noRootPlaced = await noRootAdapter.placeOrder({
    instrumentType: 'OPT',
    ticker: 'SPY',
    name: 'BCS 755/756',
    expirationDte: '0DTE',
    legs: [
      { option: 'CALL', side: 'buy', strike: 755, quantity: 10 },
      { option: 'CALL', side: 'sell', strike: 756, quantity: 10 }
    ]
  });
  assert.strictEqual(noRootPlaced.status, 'ok');
  assert.deepStrictEqual(noRootPlaced.payoff, {
    maxProfit: 100,
    maxLoss: 900,
    isMaxProfitInfinite: false,
    isMaxLossInfinite: false,
    multiplier: 100
  });
  assert.deepStrictEqual(noRootPlaced.valuation, {
    initialValue: 900,
    currentValue: 900,
    change: 0,
    changePct: 0,
    multiplier: 100,
    legs: [
      { symbol: '.SPY260531C755', basis: 2.1, current: 2.1, quantity: 10, value: 2100 },
      { symbol: '.SPY260531C756', basis: 1.2, current: 1.2, quantity: -10, value: -1200 }
    ]
  });
  assert.strictEqual(noRootCalls[0].url.endsWith('/quote/chain/live/SPY'), true);

  const calls = [];
  let rootQuoteCalls = 0;
  const adapter = new OptionStratAdapter({
    account: 'acct-1',
    cookie: 'session=abc',
    useRuntimeSettings: false,
    now: () => new Date(Date.UTC(2026, 4, 31)),
    fetch: async (url, opts = {}) => {
      calls.push({ url, opts });
      assert.strictEqual(opts.headers.Cookie, 'session=abc');
      if (url.endsWith('/quote/chain/live/SPX')) {
        rootQuoteCalls += 1;
        return response(rootQuoteCalls === 4 ? rootCloseChainSample() : rootChainSample());
      }
      if (url.endsWith('/strategy') && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.account, 'acct-1');
        assert.strictEqual(body.strategy.symbol, 'SPX');
        assert.strictEqual(body.strategy.items[0].symbol, '.SPXW260531C755');
        assert.strictEqual(body.strategy.items[0].basis, 4.1);
        return response({ ...body, code: 'deal-1', account: 'acct-1' });
      }
      if (url.endsWith('/strategy/deal-1') && opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.strategy.items[0].revision, 1);
        assert.strictEqual(body.strategy.items[0].close, 4.5);
        return response({ ...body, code: 'deal-1' });
      }
      throw new Error(`Unexpected request ${url}`);
    }
  }, 'optionstrat');

  const estimate = await adapter.estimateOrder({
    instrumentType: 'OPT',
    ticker: 'SPXW',
    root: 'SPX',
    name: 'BCS 755/756',
    expirationDte: '0DTE',
    legs: built.row.legs
  });
  assert.strictEqual(estimate.status, 'ok');
  assert.deepStrictEqual(estimate.payoff, {
    maxProfit: -900,
    maxLoss: 1900,
    isMaxProfitInfinite: false,
    isMaxLossInfinite: false,
    multiplier: 100
  });

  const placed = await adapter.placeOrder({
    instrumentType: 'OPT',
    ticker: 'SPXW',
    root: 'SPX',
    name: 'BCS 755/756',
    expirationDte: '0DTE',
    legs: built.row.legs
  });
  assert.strictEqual(placed.status, 'ok');
  assert.strictEqual(placed.providerOrderId, 'deal-1');
  assert.deepStrictEqual(placed.payoff, {
    maxProfit: -900,
    maxLoss: 1900,
    isMaxProfitInfinite: false,
    isMaxLossInfinite: false,
    multiplier: 100
  });
  assert.strictEqual(placed.valuation.change, 0);
  const liveValuation = await adapter.getStrategyValuation('deal-1', 'SPXW');
  assert.strictEqual(liveValuation.status, 'ok');
  assert.strictEqual(liveValuation.valuation.initialValue, 1900);
  assert.strictEqual(liveValuation.valuation.currentValue, 1900);
  assert.strictEqual(liveValuation.valuation.changePct, 0);
  const closed = await adapter.cancelOrder('deal-1', 'SPXW');
  assert.strictEqual(closed.status, 'ok');
  assert.deepStrictEqual(closed.valuation, {
    initialValue: 1900,
    currentValue: 2500,
    change: 600,
    changePct: 31.58,
    multiplier: 100,
    legs: [
      { symbol: '.SPXW260531C755', basis: 4.1, current: 4.5, quantity: 10, value: 4500 },
      { symbol: '.SPXW260531C756', basis: 2.2, current: 2, quantity: -10, value: -2000 }
    ]
  });
  assert.deepStrictEqual(closed.raw.valuation, closed.valuation);
  assert.strictEqual(calls.length, 6);

  console.log('optionstrat tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
