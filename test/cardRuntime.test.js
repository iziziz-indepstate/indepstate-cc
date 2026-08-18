const assert = require('assert');
const { createCardRuntime } = require('../app/infrastructure/renderer/cardRuntime');

function run() {
  const uiState = new Map([['old', { expanded: true }]]);
  const shellState = { filter: '' };
  const runtime = createCardRuntime({ state: shellState, uiState });

  for (const name of [
    'connectLegacyOrderCardRenderer',
    'legacyRows',
    'findLegacyRowByKey',
    'setLegacyRowCardState',
    'registerOrderCardInstrumentHandler',
    'registerOrderCardTypeHandler',
    'registerRendererLayer',
    'registerRendererRowProvider',
    'registerRendererLegacyGuard'
  ]) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(runtime, name), false, `${name} must be removed`);
  }

  runtime.stateApi.setCardState('old', 'pending');
  runtime.stateApi.setPendingExecLabel('old', 'bar-close');
  runtime.stateApi.markPlacedOrder('old', { ticket: 't1' });
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

  const calls = [];
  const body = { type: 'snapshot-body' };
  const control = { type: 'snapshot-control' };
  const card = { type: 'snapshot-card' };
  const removed = [];
  runtime.registerCardView('snapshot-view', context => {
    calls.push(['view', context]);
    return body;
  });
  runtime.registerCardControl('snapshot-actions', context => {
    calls.push(['control', context]);
    return control;
  });
  runtime.registerCardShape('snapshot-shape', context => {
    calls.push(['shape', context]);
    return card;
  });
  const unregister = runtime.registerCardType({
    type: 'snapshot',
    view: 'snapshot-view',
    controls: ['snapshot-actions'],
    shape: 'snapshot-shape',
    onRemovePosition(position, context) {
      removed.push([position, context]);
      return true;
    }
  });

  const snapshot = {
    id: 'position-1',
    card: {
      type: 'snapshot',
      actions: [{ id: 'OPEN', command: 'position.open' }]
    }
  };
  const requestRemove = () => true;
  const dispatchPositionAction = () => true;
  assert.strictEqual(runtime.createPositionCard(snapshot, {
    key: 'position|position-1',
    requestRemove,
    dispatchPositionAction
  }), card);
  assert.deepStrictEqual(calls.map(call => call[0]), ['view', 'control', 'shape']);
  assert.strictEqual(calls[0][1].kind, 'position');
  assert.strictEqual(calls[1][1].body, body);
  assert.strictEqual(calls[2][1].view, body);
  assert.deepStrictEqual(calls[2][1].controls, [control]);
  assert.strictEqual(calls[2][1].actions, snapshot.card.actions);
  assert.strictEqual(runtime.cleanupPositionCard(snapshot, { reason: 'removed' }), true);
  assert.strictEqual(removed[0][0], snapshot);

  assert.strictEqual(runtime.createPositionCard({ card: { type: 'unknown' } }), undefined);
  assert.strictEqual(runtime.cleanupPositionCard({ card: { type: 'unknown' } }), false);
  unregister();
  assert.strictEqual(runtime.resolveCardType(snapshot), undefined);

  console.log('cardRuntime tests passed');
}

run();
