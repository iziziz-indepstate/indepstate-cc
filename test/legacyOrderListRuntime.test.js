const assert = require('assert');
const { createLegacyOrderListRuntime } = require('../app/services/orderCards/legacyOrderListRuntime');

function createRuntime(overrides = {}) {
  const handlers = {};
  let runtime;
  const rowKey = row => `${row.ticker}|${row.event}|${row.time}|${row.price}`;
  const setCardState = (key, state) => {
    if (state) runtime.legacyState.cardStates.set(key, state);
    else runtime.legacyState.cardStates.delete(key);
  };
  runtime = createLegacyOrderListRuntime({
    ipcRenderer: {
      on: (channel, fn) => { handlers[channel] = fn; },
      invoke: async () => []
    },
    rowKey,
    findKeyByTicker: ticker => {
      const row = runtime.state.rows.find(item => item.ticker === ticker);
      return row ? rowKey(row) : null;
    },
    matchesExistingOrderRow: (incoming, existing) => incoming.ticker === existing.ticker,
    isTerminalCardState: state => ['closed', 'profit', 'loss'].includes(state),
    cardByKey: () => null,
    setCardState,
    orderCardHandlerForRow: () => null,
    orderCardHandlerForKey: () => null,
    scheduleOrderCardInstantExecution: () => {},
    removePositionSnapshotsForLegacyRow: () => false,
    positionRemovalHandlerFor: () => null,
    positionMatchesLegacyRow: (position, row) => position.ticker === row.ticker,
    isRegularPositionSnapshot: position => (position.card?.type || 'regular') === 'regular',
    render: () => {},
    now: () => 123,
    ...overrides
  });
  runtime.registerIpcHandlers({ place: async () => ({ status: 'ok' }) });
  return { runtime, handlers, rowKey };
}

async function run() {
  {
    const { runtime, handlers } = createRuntime();
    handlers['orders:new'](null, { ticker: 'AAPL', event: 'up', time: 1, price: 100, qty: 1 });
    handlers['orders:new'](null, { ticker: 'MSFT', event: 'up', time: 1, price: 50 });
    handlers['orders:new'](null, { ticker: 'AAPL', event: 'down', time: 2, price: 101, qty: 2 });
    assert.strictEqual(runtime.rows().length, 2);
    assert.deepStrictEqual(runtime.rows()[0], { ticker: 'AAPL', event: 'down', time: 2, price: 101, qty: 2 });
  }

  {
    const { runtime, handlers } = createRuntime();
    const row = { ticker: 'AAPL', event: 'up', time: 1, price: 100, qty: 1 };
    handlers['orders:new'](null, row);
    runtime.markTouched('AAPL');
    handlers['orders:new'](null, { ticker: 'AAPL', event: 'down', time: 2, price: 101, qty: 2 });
    assert.strictEqual(runtime.rows().length, 1);
    assert.deepStrictEqual(runtime.rows()[0], row);
  }

  {
    const { runtime, handlers, rowKey } = createRuntime();
    const row = { ticker: 'AAPL', event: 'up', time: 1, price: 100 };
    handlers['orders:new'](null, row);
    runtime.legacyState.cardStates.set(rowKey(row), 'closed');
    handlers['orders:new'](null, { ticker: 'AAPL', event: 'down', time: 2, price: 101 });
    assert.deepStrictEqual(runtime.rows()[0], row);

    runtime.setClosedCardEventStrategy('revive');
    handlers['orders:new'](null, { ticker: 'AAPL', event: 'down', time: 2, price: 101 });
    assert.strictEqual(runtime.rows()[0].event, 'down');
    assert.strictEqual(runtime.legacyState.cardStates.has(rowKey(row)), false);
  }

  {
    const { runtime, handlers, rowKey } = createRuntime();
    const row = { ticker: 'AAPL', symbol: 'AAPL', event: 'up', time: 1, price: 100, provider: 'simulated' };
    handlers['orders:new'](null, row);
    const key = rowKey(row);
    runtime.legacyState.pendingByReqId.set('req-1', key);
    runtime.legacyState.pendingIdByReqId.set('req-1', 'pending-1');
    runtime.legacyState.retryCounts.set('req-1', 2);
    handlers['execution:result'](null, {
      reqId: 'req-1',
      provider: 'simulated',
      status: 'ok',
      providerOrderId: 'ticket-1',
      order: { symbol: 'AAPL', side: 'buy', qty: 1, meta: { requestId: 'req-1' } }
    });
    assert.strictEqual(runtime.legacyState.pendingByReqId.has('req-1'), false);
    assert.strictEqual(runtime.legacyState.pendingIdByReqId.has('req-1'), false);
    assert.strictEqual(runtime.legacyState.retryCounts.has('req-1'), false);
    assert.strictEqual(runtime.legacyState.ticketToKey.get('ticket-1'), key);
    assert.strictEqual(runtime.legacyState.placedOrderByKey.get(key).ticket, 'ticket-1');
  }

  {
    const { runtime, handlers, rowKey } = createRuntime();
    const row = { ticker: 'AAPL', event: 'up', time: 1, price: 100, provider: 'simulated' };
    handlers['orders:new'](null, row);
    const key = rowKey(row);
    runtime.legacyState.ticketToKey.set('ticket-1', key);
    runtime.legacyState.placedOrderByKey.set(key, { ticket: 'ticket-1' });
    handlers['position:opened'](null, { ticket: 'ticket-1', origOrder: {} });
    assert.strictEqual(runtime.legacyState.cardStates.get(key), 'executing');
    assert.strictEqual(runtime.legacyState.placedOrderByKey.has(key), false);
    handlers['position:closed'](null, { ticket: 'ticket-1', profit: -5 });
    assert.strictEqual(runtime.legacyState.cardStates.get(key), 'loss');
    handlers['order:cancelled'](null, { ticket: 'ticket-1' });
    assert.strictEqual(runtime.rows().length, 0);
    assert.strictEqual(runtime.legacyState.ticketToKey.has('ticket-1'), false);
  }

  console.log('legacyOrderListRuntime tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
