const assert = require('assert');
const { createLegacyOrderListRuntime } = require('../app/services/orderCards/legacyOrderListRuntime');
const {
  isRegularLegacyRow,
  shouldCreatePositionSnapshot,
  shouldRouteRowToLegacyRuntime
} = require('../app/services/orderCards/legacyRouting');

function createRuntime(overrides = {}) {
  const handlers = {};
  let runtime;
  let renderCount = 0;
  const rowKey = row => `${row.ticker}|${row.event}|${row.time}|${row.price}`;
  const setCardState = (key, state) => {
    if (state) runtime.legacyOrderStateApi.setCardState(key, state);
    else runtime.legacyOrderStateApi.clearCardState(key);
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
    positionMatchesLegacyRow: (position, row) => position.ticker === row.ticker,
    isRegularPositionSnapshot: position => (position.card?.type || 'regular') === 'regular',
    render: () => { renderCount += 1; },
    now: () => 123,
    ...overrides
  });
  runtime.registerIpcHandlers({ place: async () => ({ status: 'ok' }) });
  return {
    runtime,
    handlers,
    rowKey,
    getRenderCount: () => renderCount,
    resetRenderCount: () => { renderCount = 0; }
  };
}

async function run() {
  {
    assert.strictEqual(isRegularLegacyRow({}), true);
    assert.strictEqual(isRegularLegacyRow({ cardType: 'regular' }), true);
    assert.strictEqual(isRegularLegacyRow({ type: 'regular' }), true);
    assert.strictEqual(shouldRouteRowToLegacyRuntime({ cardType: 'legacyExtension' }), true);
    assert.strictEqual(shouldRouteRowToLegacyRuntime({ type: 'extension' }), true);
    assert.strictEqual(shouldRouteRowToLegacyRuntime({ cardType: 'levelOrder' }), false);
    assert.strictEqual(shouldRouteRowToLegacyRuntime({ cardType: 'option' }), true);
    assert.strictEqual(shouldRouteRowToLegacyRuntime({ cardType: 'optionstrat' }), true);
    assert.strictEqual(shouldRouteRowToLegacyRuntime({ cardType: 'regular' }), false);
    assert.strictEqual(shouldCreatePositionSnapshot({ cardType: 'levelOrder' }), true);
    assert.strictEqual(shouldCreatePositionSnapshot({ cardType: 'option' }), true);
    assert.strictEqual(shouldCreatePositionSnapshot({ cardType: 'optionstrat' }), true);
    assert.strictEqual(shouldCreatePositionSnapshot({ cardType: 'legacyExtension' }), false);
  }

  {
    const { runtime, handlers } = createRuntime();
    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'legacyExtension', ticker: 'AAPL', event: 'up', time: 1, price: 100, qty: 1 } });
    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'legacyExtension', ticker: 'MSFT', event: 'up', time: 1, price: 50 } });
    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'legacyExtension', ticker: 'AAPL', event: 'down', time: 2, price: 101, qty: 2 } });
    assert.strictEqual(runtime.rows().length, 2);
    assert.deepStrictEqual(runtime.rows()[0], { cardType: 'legacyExtension', ticker: 'AAPL', event: 'down', time: 2, price: 101, qty: 2 });
  }

  {
    const { runtime, handlers, getRenderCount } = createRuntime();
    handlers['order-cards:changed'](null, { type: 'upsert', row: { ticker: 'AAPL', event: 'up', time: 1, price: 100 } });
    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'regular', ticker: 'MSFT', event: 'up', time: 1, price: 50 } });
    assert.strictEqual(runtime.rows().length, 0);
    assert.strictEqual(getRenderCount(), 0);
  }

  {
    const { runtime } = createRuntime({
      ipcRenderer: {
        on: () => {},
        invoke: async () => [
          { ticker: 'AAPL', event: 'up', time: 1, price: 100 },
          { cardType: 'regular', ticker: 'MSFT', event: 'up', time: 1, price: 50 },
          { cardType: 'legacyExtension', ticker: 'TSLA', event: 'custom', time: 2, price: 200 }
        ]
      }
    });
    runtime.mount();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepStrictEqual(runtime.rows().map(row => row.ticker), ['TSLA']);
  }

  {
    const { runtime, handlers, getRenderCount, resetRenderCount } = createRuntime();
    const row = { cardType: 'legacyExtension', ticker: 'AAPL', event: 'up', time: 1, price: 100, producingLineId: 'line-1' };
    handlers['order-cards:changed'](null, { type: 'upsert', row });
    resetRenderCount();
    handlers['order-cards:changed'](null, { type: 'remove', filter: { producingLineId: 'line-1' }, eventId: 'evt-remove-1' });
    assert.strictEqual(runtime.rows().length, 0);
    assert.strictEqual(getRenderCount(), 1);
  }

  {
    const { runtime, handlers, getRenderCount } = createRuntime();
    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'legacyExtension', ticker: 'AAPL', event: 'up', time: 1, price: 100 } });
    assert.strictEqual(runtime.rows().length, 1);
    assert.strictEqual(getRenderCount(), 1);
  }

  {
    const { runtime, handlers } = createRuntime();
    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'legacyExtension', ticker: 'AAPL', event: 'up', time: 1, price: 100, producingLineId: 'line-1' } });
    handlers['order-cards:changed'](null, { type: 'remove', filter: { producingLineId: 'line-1' } });
    assert.strictEqual(runtime.rows().length, 0);
  }

  {
    const { runtime, handlers } = createRuntime();
    const row = { cardType: 'legacyExtension', ticker: 'AAPL', event: 'up', time: 1, price: 100, qty: 1 };
    handlers['order-cards:changed'](null, { type: 'upsert', row });
    runtime.markTouched('AAPL');
    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'legacyExtension', ticker: 'AAPL', event: 'down', time: 2, price: 101, qty: 2 } });
    assert.strictEqual(runtime.rows().length, 1);
    assert.deepStrictEqual(runtime.rows()[0], row);
  }

  {
    const { runtime, handlers, rowKey } = createRuntime();
    const row = { cardType: 'legacyExtension', ticker: 'AAPL', event: 'up', time: 1, price: 100 };
    handlers['order-cards:changed'](null, { type: 'upsert', row });
    runtime.legacyOrderStateApi.setCardState(rowKey(row), 'closed');
    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'legacyExtension', ticker: 'AAPL', event: 'down', time: 2, price: 101 } });
    assert.deepStrictEqual(runtime.rows()[0], row);

    runtime.setClosedCardEventStrategy('revive');
    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'legacyExtension', ticker: 'AAPL', event: 'down', time: 2, price: 101 } });
    assert.strictEqual(runtime.rows()[0].event, 'down');
    assert.strictEqual(runtime.legacyOrderStateApi.getCardState(rowKey(row)), undefined);
  }

  {
    const { runtime, handlers, rowKey } = createRuntime();
    const row = { cardType: 'legacyExtension', ticker: 'AAPL', symbol: 'AAPL', event: 'up', time: 1, price: 100, provider: 'simulated' };
    handlers['order-cards:changed'](null, { type: 'upsert', row });
    const key = rowKey(row);
    runtime.legacyOrderStateApi.markPendingRequest('req-1', key, { retryCount: 2, pendingId: 'pending-1' });
    handlers['execution:result'](null, {
      reqId: 'req-1',
      provider: 'simulated',
      status: 'ok',
      providerOrderId: 'ticket-1',
      order: { symbol: 'AAPL', side: 'buy', qty: 1, meta: { requestId: 'req-1' } }
    });
    assert.strictEqual(runtime.legacyOrderStateApi.resolvePendingKey('req-1'), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.getPendingId('req-1'), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.getRetryCount('req-1'), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.resolveTicketKey('ticket-1'), key);
    assert.strictEqual(runtime.legacyOrderStateApi.getPlacedOrder(key).ticket, 'ticket-1');
  }

  {
    const { runtime, handlers, rowKey } = createRuntime();
    const row = { cardType: 'legacyExtension', ticker: 'AAPL', event: 'up', time: 1, price: 100, provider: 'simulated' };
    handlers['order-cards:changed'](null, { type: 'upsert', row });
    const key = rowKey(row);
    runtime.legacyOrderStateApi.bindTicket('ticket-1', key);
    runtime.legacyOrderStateApi.markPlacedOrder(key, { ticket: 'ticket-1' });
    handlers['position:opened'](null, { ticket: 'ticket-1', origOrder: {} });
    assert.strictEqual(runtime.legacyOrderStateApi.getCardState(key), 'executing');
    assert.strictEqual(runtime.legacyOrderStateApi.getPlacedOrder(key), undefined);
    handlers['position:closed'](null, { ticket: 'ticket-1', profit: -5 });
    assert.strictEqual(runtime.legacyOrderStateApi.getCardState(key), 'loss');
    handlers['order:cancelled'](null, { ticket: 'ticket-1' });
    assert.strictEqual(runtime.rows().length, 0);
    assert.strictEqual(runtime.legacyOrderStateApi.resolveTicketKey('ticket-1'), undefined);
  }

  {
    const { runtime } = createRuntime();
    const key = 'row|key';
    runtime.legacyOrderStateApi.markPendingRequest('req-1', key, { retryCount: 3, pendingId: 'pending-1' });
    assert.strictEqual(runtime.legacyOrderStateApi.resolvePendingKey('req-1'), key);
    assert.strictEqual(runtime.legacyOrderStateApi.findPendingRequestIdByKey(key), 'req-1');
    assert.strictEqual(runtime.legacyOrderStateApi.getPendingId('req-1'), 'pending-1');
    assert.strictEqual(runtime.legacyOrderStateApi.getRetryCount('req-1'), 3);
    runtime.legacyOrderStateApi.setPendingId('req-1', 'pending-2');
    assert.strictEqual(runtime.legacyOrderStateApi.getPendingId('req-1'), 'pending-2');
    runtime.legacyOrderStateApi.clearPendingRequest('req-1');
    assert.strictEqual(runtime.legacyOrderStateApi.resolvePendingKey('req-1'), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.findPendingRequestIdByKey(key), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.getRetryCount('req-1'), undefined);
    runtime.legacyOrderStateApi.markPendingRequest('req-2', key);
    runtime.legacyOrderStateApi.clearPendingByKey(key);
    assert.strictEqual(runtime.legacyOrderStateApi.resolvePendingKey('req-2'), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.findPendingRequestIdByKey(key), undefined);
  }

  {
    const { runtime } = createRuntime();
    const key = 'row|key';
    runtime.legacyOrderStateApi.markPlacedOrder(key, { provider: 'simulated', ticket: 'ticket-1', symbol: 'AAPL' });
    runtime.legacyOrderStateApi.bindTicket('ticket-1', key);
    assert.strictEqual(runtime.legacyOrderStateApi.resolveTicketKey('ticket-1'), key);
    assert.strictEqual(runtime.legacyOrderStateApi.getPlacedOrder(key).ticket, 'ticket-1');
    assert.deepStrictEqual(runtime.legacyOrderStateApi.listPlacedOrders(), [{
      key,
      orderInfo: { provider: 'simulated', ticket: 'ticket-1', symbol: 'AAPL' },
      state: undefined
    }]);
    runtime.legacyOrderStateApi.deletePlacedOrder(key);
    runtime.legacyOrderStateApi.unbindTicket('ticket-1');
    assert.strictEqual(runtime.legacyOrderStateApi.getPlacedOrder(key), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.resolveTicketKey('ticket-1'), undefined);
  }

  {
    const { runtime, handlers, rowKey } = createRuntime();
    const row = { cardType: 'legacyExtension', ticker: 'AAPL', event: 'up', time: 1, price: 100 };
    handlers['order-cards:changed'](null, { type: 'upsert', row });
    const oldKey = rowKey(row);
    runtime.legacyOrderStateApi.markPendingRequest('req-1', oldKey, { pendingId: 'pending-1' });
    runtime.legacyOrderStateApi.setPendingExecLabel(oldKey, 'OPEN');
    runtime.legacyOrderStateApi.setCardState(oldKey, 'pending');
    runtime.legacyOrderStateApi.markPlacedOrder(oldKey, { ticket: 'ticket-1' });
    runtime.legacyOrderStateApi.bindTicket('ticket-1', oldKey);

    handlers['order-cards:changed'](null, { type: 'upsert', row: { cardType: 'legacyExtension', ticker: 'AAPL', event: 'down', time: 2, price: 101 } });
    const newKey = rowKey(runtime.rows()[0]);
    assert.notStrictEqual(newKey, oldKey);
    assert.strictEqual(runtime.legacyOrderStateApi.resolvePendingKey('req-1'), newKey);
    assert.strictEqual(runtime.legacyOrderStateApi.getPendingExecLabel(newKey), 'OPEN');
    assert.strictEqual(runtime.legacyOrderStateApi.getCardState(newKey), 'pending');
    assert.strictEqual(runtime.legacyOrderStateApi.getPlacedOrder(newKey).ticket, 'ticket-1');
    assert.strictEqual(runtime.legacyOrderStateApi.resolveTicketKey('ticket-1'), newKey);
    runtime.legacyOrderStateApi.clearExecutionStateByKey(newKey);
    assert.strictEqual(runtime.legacyOrderStateApi.resolvePendingKey('req-1'), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.getPendingExecLabel(newKey), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.getCardState(newKey), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.getPlacedOrder(newKey), undefined);
    assert.strictEqual(runtime.legacyOrderStateApi.resolveTicketKey('ticket-1'), undefined);
  }

  console.log('legacyOrderListRuntime tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
