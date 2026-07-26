const assert = require('assert');
const { EventEmitter } = require('events');
const { CCXTExecutionAdapter } = require('../app/services/brokerage-adapter-ccxt/comps/ccxt');

function makeAdapter() {
  const adapter = Object.create(CCXTExecutionAdapter.prototype);
  adapter.provider = 'ccxt-binance-futures';
  adapter.events = new EventEmitter();
  adapter.pending = new Map();
  adapter._ticketToSymbol = new Map();
  adapter._ticketOpened = new Set();
  adapter._positionClosedTickets = new Set();
  adapter._brackets = new Map();
  adapter._entryClientToBracket = new Map();
  adapter._cancelCalls = 0;
  adapter.mapSymbol = symbol => symbol === 'BTCUSDT' ? 'BTC/USDT:USDT' : symbol;
  adapter.cancelBracketProtection = async () => { adapter._cancelCalls += 1; };
  adapter._detectManualProtectiveOrderModifications = () => {};
  adapter._binanceSignedRequest = async (_method, endpoint) => {
    if (endpoint === '/fapi/v2/positionRisk') {
      return [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0' }];
    }
    if (endpoint === '/fapi/v1/openAlgoOrders') return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  return adapter;
}

function addBracket(adapter, suffix = '1') {
  const bracket = {
    bracketId: `b${suffix}`,
    symbol: 'BTCUSDT',
    mappedSymbol: 'BTC/USDT:USDT',
    positionSide: 'BOTH',
    direction: 'LONG',
    entryClientOrderId: `br_b${suffix}_entry`,
    entryOrderId: Number(`10${suffix}`),
    tpClientAlgoId: `br_b${suffix}_tp`,
    slClientAlgoId: `br_b${suffix}_sl`,
    status: 'PROTECTED',
    expectedQty: '1',
    actualQty: '1',
    pendingId: `cid-${suffix}`,
    origOrder: { symbol: 'BTCUSDT', side: 'buy' },
    uiConfirmed: false,
    uiRejected: false,
  };
  adapter._brackets.set(bracket.bracketId, bracket);
  adapter._entryClientToBracket.set(bracket.entryClientOrderId, bracket.bracketId);
  adapter.pending.set(bracket.pendingId, { order: bracket.origOrder });
  return bracket;
}

(async () => {
  {
    const adapter = makeAdapter();
    adapter.normalizeBinanceUsdmSymbol = async () => 'BTCUSDT';
    adapter._getBinanceSymbolFilters = async () => ({ tickSize: 0.1, stepSize: 0.001, minNotional: 5 });
    adapter._binanceSignedRequest = async (method, endpoint) => {
      assert.strictEqual(endpoint, '/fapi/v1/order');
      if (method === 'GET') throw new Error('binance {"code":-2013,"msg":"Order does not exist."}');
      assert.strictEqual(method, 'POST');
      return { orderId: 100, status: 'NEW' };
    };
    adapter._startBracketEntryWatcher = async () => {};
    const confirmed = [];
    const opened = [];
    adapter.events.on('order:confirmed', event => confirmed.push(event));
    adapter.events.on('position:opened', event => opened.push(event));

    const result = await adapter._placeBinanceBracketEntry({
      order: { symbol: 'BTCUSDT', side: 'buy', takeProfitPrice: 110, stopLossPrice: 90 },
      symbol: 'BTC/USDT:USDT',
      side: 'BUY',
      amount: 1,
      price: 100,
      params: {},
      cid: 'cid-entry'
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(result.providerOrderId, 'pending:cid-entry');
    assert.strictEqual(confirmed.length, 1);
    assert.strictEqual(confirmed[0].ticket, '100');
    assert.strictEqual(opened.length, 0);
    assert.strictEqual(adapter._brackets.get('cid-entry').status, 'ENTRY_PLACED');
  }

  {
    const adapter = makeAdapter();
    const bracket = addBracket(adapter, '1');
    const confirmed = [];
    const opened = [];
    const closed = [];
    adapter.events.on('order:confirmed', event => confirmed.push(event));
    adapter.events.on('position:opened', event => opened.push(event));
    adapter.events.on('position:closed', event => closed.push(event));

    adapter._confirmBracketPending(bracket, { orderId: bracket.entryOrderId });
    adapter._confirmBracketPending(bracket, { orderId: bracket.entryOrderId });

    const ticket = String(bracket.entryOrderId);
    assert.strictEqual(confirmed.length, 1);
    assert.strictEqual(opened.length, 0);
    adapter._markBracketOpened(bracket, { orderId: bracket.entryOrderId });
    adapter._markBracketOpened(bracket, { orderId: bracket.entryOrderId });
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(confirmed[0].ticket, ticket);
    assert.strictEqual(opened[0].ticket, ticket);
    assert.strictEqual(adapter._ticketToSymbol.get(ticket), 'BTC/USDT:USDT');
    assert(adapter._ticketOpened.has(ticket));

    await adapter._reconcileBrackets();
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0].ticket, ticket);
    assert.strictEqual(closed[0].trade.pnlStatus, 'unavailable');
    assert.strictEqual(bracket.status, 'CLOSED');
    assert.strictEqual(adapter._cancelCalls, 1);
    assert.strictEqual(adapter._emitPositionClosed(ticket, { pnlStatus: 'unavailable' }), false);
    assert.strictEqual(closed.length, 1);
  }

  {
    const adapter = makeAdapter();
    const bracket = addBracket(adapter, '2');
    const closed = [];
    adapter.events.on('position:closed', event => closed.push(event));
    adapter._confirmBracketPending(bracket, { orderId: bracket.entryOrderId });
    adapter._markBracketOpened(bracket, { orderId: bracket.entryOrderId });

    await adapter._onAccountUpdate({ a: { P: [{ s: 'BTCUSDT', ps: 'BOTH', pa: '0' }] } });
    await adapter._onAccountUpdate({ a: { P: [{ s: 'BTCUSDT', ps: 'BOTH', pa: '0' }] } });

    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0].ticket, String(bracket.entryOrderId));
    assert.strictEqual(bracket.status, 'CLOSED');
    assert.strictEqual(adapter._cancelCalls, 1);
  }

  {
    const adapter = makeAdapter();
    const bracket = addBracket(adapter, '3');
    bracket.status = 'ENTRY_PLACED';
    bracket.uiConfirmed = false;
    const closed = [];
    adapter.events.on('position:closed', event => closed.push(event));

    await adapter._onAccountUpdate({ a: { P: [{ s: 'BTCUSDT', ps: 'BOTH', pa: '0' }] } });

    assert.strictEqual(closed.length, 0);
    assert.strictEqual(bracket.status, 'ENTRY_PLACED');
    assert.strictEqual(adapter._cancelCalls, 0);
  }

  {
    const adapter = makeAdapter();
    const bracket = addBracket(adapter, '4');
    bracket.status = 'ENTRY_PLACED';
    bracket.actualQty = null;
    bracket.expectedQty = '2';
    adapter._placeBracketProtection = async () => {
      bracket.status = 'PROTECTED';
    };
    adapter._binanceSignedRequest = async (_method, endpoint, params) => {
      if (endpoint === '/fapi/v1/order') throw new Error('temporary order lookup failure');
      if (endpoint === '/fapi/v1/userTrades') {
        assert.strictEqual(params.orderId, bracket.entryOrderId);
        return [
          { orderId: bracket.entryOrderId, qty: '0.75' },
          { orderId: bracket.entryOrderId, qty: '1.25' },
          { orderId: 999999, qty: '50' }
        ];
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    const opened = [];
    adapter.events.on('position:opened', event => opened.push(event));

    await adapter._reconcileBrackets();
    await adapter._reconcileBrackets();

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].ticket, String(bracket.entryOrderId));
    assert.strictEqual(opened[0].origOrder, bracket.origOrder);
    assert.strictEqual(bracket.actualQty, '2');
    assert.strictEqual(bracket.status, 'PROTECTED');

    const positions = await adapter.listOpenPositions('BTCUSDT');
    assert.strictEqual(positions.length, 1);
    assert.strictEqual(positions[0].ticket, String(bracket.entryOrderId));
    assert.strictEqual(positions[0].qty, 2);
    assert.strictEqual(positions[0].clientOrderId, bracket.pendingId);
    assert.strictEqual(positions[0].__isPosition, true);
    assert.deepStrictEqual(await adapter.listOpenPositions('ETHUSDT'), []);
  }

  {
    const adapter = makeAdapter();
    const bracket = addBracket(adapter, 'entry-cancel');
    bracket.status = 'ENTRY_PLACED';
    let placementCalls = 0;
    const cancelled = [];
    adapter._placeBracketProtection = async () => { placementCalls += 1; };
    adapter.events.on('order:cancelled', event => cancelled.push(event));
    adapter._binanceSignedRequest = async (_method, endpoint) => {
      if (endpoint === '/fapi/v1/order') return { status: 'CANCELED', orderId: bracket.entryOrderId };
      if (endpoint === '/fapi/v1/userTrades') return [];
      throw new Error(`unexpected endpoint ${endpoint}`);
    };

    await adapter._reconcileBrackets();

    assert.strictEqual(bracket.status, 'CANCELED');
    assert.strictEqual(adapter._cancelCalls, 1);
    assert.strictEqual(placementCalls, 0);
    assert.strictEqual(cancelled.length, 1);
  }

  {
    const adapter = makeAdapter();
    const bracket = addBracket(adapter, 'entry-update-cancel');
    bracket.status = 'ENTRY_PLACED';
    let placementCalls = 0;
    adapter._placeBracketProtection = async () => { placementCalls += 1; };

    await adapter._onOrderTradeUpdate({ o: { c: bracket.entryClientOrderId, X: 'CANCELED' } });

    assert.strictEqual(bracket.status, 'CANCELED');
    assert.strictEqual(adapter._cancelCalls, 1);
    assert.strictEqual(placementCalls, 0);
  }

  {
    const adapter = makeAdapter();
    const bracket = addBracket(adapter, 'manual-close');
    adapter.exchange = {
      fetchPositions: async () => [{ symbol: 'BTC/USDT:USDT', contracts: 1, entryPrice: 100 }]
    };
    adapter._desiredProtectionByTicket = new Map();
    adapter._desiredProtectionByTicket.set(String(bracket.entryOrderId), {
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      amount: 1,
      slPts: 10,
      tpPts: 20,
      tickSize: 0.1
    });
    adapter._confirmBracketPending(bracket, { orderId: bracket.entryOrderId });
    adapter._markBracketOpened(bracket, { orderId: bracket.entryOrderId });

    await adapter._onAccountUpdate({ a: { P: [{ s: 'BTCUSDT', ps: 'BOTH', pa: '0' }] } });

    let placementCalls = 0;
    adapter._openOrdersSym = async () => [];
    adapter._placeProtectiveOrders = async () => { placementCalls += 1; return ['new-protection']; };
    await adapter._ensureProtectiveOrdersForTicket(String(bracket.entryOrderId));
    await adapter._placeBracketProtection(bracket);

    assert.strictEqual(bracket.status, 'CLOSED');
    assert.strictEqual(adapter._cancelCalls, 1);
    assert.strictEqual(placementCalls, 0);
  }

  {
    const adapter = makeAdapter();
    const bracket = addBracket(adapter, 'unknown-state');
    bracket.status = 'PROTECTED';
    adapter._confirmBracketPending(bracket, { orderId: bracket.entryOrderId });
    adapter._markBracketOpened(bracket, { orderId: bracket.entryOrderId });
    let placementCalls = 0;
    adapter._placeBracketProtection = async () => { placementCalls += 1; };
    adapter._binanceSignedRequest = async (_method, endpoint) => {
      if (endpoint === '/fapi/v2/positionRisk') throw new Error('temporary position outage');
      if (endpoint === '/fapi/v1/openAlgoOrders') throw new Error('temporary open-order outage');
      throw new Error(`unexpected endpoint ${endpoint}`);
    };

    await adapter._reconcileBrackets();

    assert.strictEqual(bracket.status, 'PROTECTED');
    assert.strictEqual(adapter._cancelCalls, 0);
    assert.strictEqual(placementCalls, 0);
  }

  {
    const adapter = makeAdapter();
    const opened = [];
    const closed = [];
    let positions = [{ symbol: 'ETH/USDT:USDT', contracts: 2, unrealizedPnl: 3 }];
    adapter.exchange = { fetchPositions: async () => positions };
    adapter._registerTrackedTicket('generic-ticket', 'ETH/USDT:USDT');
    adapter.events.on('position:opened', event => opened.push(event));
    adapter.events.on('position:closed', event => closed.push(event));

    await adapter._watchOnce();
    positions = [];
    await adapter._watchOnce();
    await adapter._watchOnce();

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0].ticket, 'generic-ticket');
    assert.strictEqual(closed[0].trade.pnlStatus, 'unavailable');
  }

  {
    const adapter = makeAdapter();
    const closed = [];
    adapter.exchange = { fetchPositions: async () => { throw new Error('temporary outage'); } };
    adapter._registerTrackedTicket('outage-ticket', 'SOL/USDT:USDT');
    adapter._ticketOpened.add('outage-ticket');
    adapter.events.on('position:closed', event => closed.push(event));

    await adapter._watchOnce();

    assert.strictEqual(closed.length, 0);
    assert(adapter._ticketOpened.has('outage-ticket'));
  }

  {
    const adapter = makeAdapter();
    let calls = 0;
    let syncs = 0;
    let ccxtSyncs = 0;
    adapter.exchange = {
      apiKey: 'key',
      secret: 'secret',
      loadTimeDifference: async () => { ccxtSyncs += 1; }
    };
    adapter._syncBinanceServerTime = async (force) => {
      if (force) syncs += 1;
      return 0;
    };
    adapter._binanceSignedRequest = CCXTExecutionAdapter.prototype._binanceSignedRequest;
    adapter._binanceSignedRequestOnce = async () => {
      calls += 1;
      if (calls === 1) throw new Error('InvalidNonce: binance {"code":-1021,"msg":"Timestamp for this request was 1000ms ahead of the server time."}');
      return { ok: true };
    };

    const result = await adapter._binanceSignedRequest('GET', '/fapi/v1/order', { symbol: 'BTCUSDT' });

    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(calls, 2);
    assert.strictEqual(syncs, 1);
    assert.strictEqual(ccxtSyncs, 1);
  }

  {
    const adapter = makeAdapter();
    adapter.normalizeBinanceUsdmSymbol = async () => 'BTCUSDT';
    adapter._getBinanceSymbolFilters = async () => ({ tickSize: 0.1, stepSize: 0.001, minNotional: 5 });
    adapter._startBracketEntryWatcher = async () => {};
    const calls = [];
    adapter._binanceSignedRequest = async (method, endpoint, params) => {
      calls.push({ method, endpoint, params });
      if (method === 'GET' && endpoint === '/fapi/v1/order') {
        if (calls.filter(call => call.method === 'GET' && call.endpoint === '/fapi/v1/order').length === 1) {
          throw new Error('binance {"code":-2013,"msg":"Order does not exist."}');
        }
        return { orderId: 777, status: 'NEW' };
      }
      if (method === 'POST' && endpoint === '/fapi/v1/order') {
        throw new Error('socket hang up after broker accepted order');
      }
      throw new Error(`unexpected ${method} ${endpoint}`);
    };

    const result = await adapter._placeBinanceBracketEntry({
      order: { symbol: 'BTCUSDT', side: 'buy', stopLossPrice: 90 },
      symbol: 'BTC/USDT:USDT',
      side: 'BUY',
      amount: 1,
      price: 100,
      params: {},
      cid: 'cid-recovered'
    });

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(adapter._brackets.get('cid-recovered').entryOrderId, 777);
    assert.strictEqual(calls.filter(call => call.method === 'POST' && call.endpoint === '/fapi/v1/order').length, 1);
    assert.strictEqual(calls.filter(call => call.method === 'GET' && call.endpoint === '/fapi/v1/order').length, 2);
  }

  {
    const adapter = makeAdapter();
    adapter._desiredProtectionByTicket = new Map();
    adapter._desiredProtectionByTicket.set('ticket-unknown', {
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      amount: 1,
      slPts: 10,
      tpPts: 20,
      tickSize: 0.1
    });
    adapter._registerTrackedTicket('ticket-unknown', 'BTC/USDT:USDT');
    adapter.exchange = {
      fetchPositions: async () => [{ symbol: 'BTC/USDT:USDT', contracts: 1, entryPrice: 100 }]
    };
    adapter._getTickSizeFromMarket = () => 0.1;
    adapter.getQuote = async () => ({ price: 100 });
    let placementCalls = 0;
    adapter._openOrdersSym = async () => { throw new Error('InvalidNonce: binance {"code":-1021}'); };
    adapter._placeProtectiveOrders = async () => { placementCalls += 1; return ['new-protection']; };

    await adapter._ensureProtectiveOrdersForTicket('ticket-unknown');

    assert.strictEqual(placementCalls, 0);
    assert(adapter._desiredProtectionByTicket.has('ticket-unknown'));
  }

  {
    const adapter = makeAdapter();
    adapter._desiredProtectionByTicket = new Map();
    adapter._desiredProtectionByTicket.set('ticket-position-unknown', {
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      amount: 1,
      slPts: 10,
      tpPts: 20,
      tickSize: 0.1
    });
    adapter._registerTrackedTicket('ticket-position-unknown', 'BTC/USDT:USDT');
    adapter.exchange = {
      fetchPositions: async () => { throw new Error('temporary position outage'); }
    };
    let openOrderCalls = 0;
    let placementCalls = 0;
    adapter._openOrdersSym = async () => { openOrderCalls += 1; return []; };
    adapter._placeProtectiveOrders = async () => { placementCalls += 1; return ['new-protection']; };

    await adapter._ensureProtectiveOrdersForTicket('ticket-position-unknown');

    assert.strictEqual(openOrderCalls, 0);
    assert.strictEqual(placementCalls, 0);
  }

  console.log('ccxt position lifecycle tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
