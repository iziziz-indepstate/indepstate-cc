const assert = require('assert');
const {
  createCardRuntime,
  createOrderStateFacades,
  createLegacyOrderStateCompatApi
} = require('../app/infrastructure/renderer/cardRuntime');

function run() {
  const uiState = new Map([['old', { expanded: true }]]);
  const shellState = { filter: '' };
  const runtime = createCardRuntime({ state: shellState, uiState });

  runtime.stateApi.setCardState('old', 'pending');
  runtime.stateApi.setPendingExecLabel('old', 'bar-close');
  runtime.stateApi.markPlacedOrder('old', { ticket: 't1', nested: { keepReference: true } });
  runtime.stateApi.markPendingRequest('req-1', 'old', { retryCount: 2, pendingId: 'p1' });
  runtime.stateApi.bindTicket('t1', 'old');
  runtime.stateApi.migrateKey('old', 'new');

  assert.strictEqual(runtime.stateApi.getCardState('new'), 'pending');
  assert.strictEqual(runtime.stateApi.getPendingExecLabel('new'), 'bar-close');
  assert.strictEqual(runtime.stateApi.resolvePendingKey('req-1'), 'new');
  assert.strictEqual(runtime.stateApi.getPendingId('req-1'), 'p1');
  assert.strictEqual(runtime.stateApi.getRetryCount('req-1'), 2);
  assert.strictEqual(runtime.stateApi.resolveTicketKey('t1'), 'new');
  assert.deepStrictEqual(uiState.get('new'), { expanded: true });

  runtime.stateFacades.cardVisualState.clearExecutionStateByKey('new');
  assert.strictEqual(runtime.stateFacades.cardVisualState.getCardState('new'), undefined);
  assert.strictEqual(runtime.stateFacades.placedOrderLookup.getPlacedOrder('new'), undefined);
  assert.strictEqual(runtime.stateFacades.ticketBinding.resolveTicketKey('t1'), undefined);

  runtime.stateApi.setFilter('OPT');
  assert.strictEqual(shellState.filter, 'OPT');

  const unregisterType = runtime.registerCardType({ type: 'option', shape: 'trade-card' });
  runtime.registerCardType({ type: 'fallback', match: card => card.kind === 'fallback' });
  assert.strictEqual(runtime.resolveCardType({ card: { type: 'option' } }).shape, 'trade-card');
  assert.strictEqual(runtime.resolveCardType({ kind: 'fallback' }).type, 'fallback');
  unregisterType();
  assert.strictEqual(runtime.resolveCardType({ card: { type: 'option' } }), undefined);

  const view = () => 'view';
  const control = () => 'control';
  const shape = () => 'shape';
  const unregisterView = runtime.registerCardView('identity', view);
  const unregisterControl = runtime.registerCardControl('remove', control);
  const unregisterShape = runtime.registerCardShape('trade-card', shape);
  assert.strictEqual(runtime.getCardView('identity'), view);
  assert.strictEqual(runtime.getCardControl('remove'), control);
  assert.strictEqual(runtime.getCardShape('trade-card'), shape);
  unregisterView();
  unregisterControl();
  unregisterShape();
  assert.strictEqual(runtime.getCardView('identity'), undefined);
  assert.strictEqual(runtime.getCardControl('remove'), undefined);
  assert.strictEqual(runtime.getCardShape('trade-card'), undefined);

  const legacyApi = {
    getCardState: key => (key === 'legacy' ? 'placed' : undefined),
    listPlacedOrders: () => [{ key: 'legacy', orderInfo: { ticket: 'l1' }, state: 'placed' }]
  };
  const facades = createOrderStateFacades(legacyApi, runtime.stateApi);
  const compat = createLegacyOrderStateCompatApi(facades);
  assert.strictEqual(compat.getCardState('legacy'), 'placed');
  assert.deepStrictEqual(compat.listPlacedOrders(), [{ key: 'legacy', orderInfo: { ticket: 'l1' }, state: 'placed' }]);

  console.log('cardRuntime tests passed');
}

run();
