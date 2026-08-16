const assert = require('assert');
const { JSDOM } = require('jsdom');
const {
  createCardStateApi,
  createOrderStateFacades,
  createLegacyRowPresentationAdapter
} = require('../app/infrastructure/renderer/cardRuntime');

function createHarness(handler = {}) {
  const dom = new JSDOM(`<!DOCTYPE html>
    <div class="card" data-rowkey="row-1" data-ticker="AAPL">
      <div class="row">
        <span class="card__status"></span>
        <span class="card__spread">1 / 2 / 3</span>
        <button class="retry-btn">0</button>
        <button class="card__close">×</button>
      </div>
      <div class="meta">meta</div>
      <div class="quad-line"><input value="10"></div>
      <div class="extraRow"><input value="20"></div>
      <div class="btns">
        <button class="btn open primary">OPEN</button>
        <button class="btn secondary">SECOND</button>
      </div>
      <div class="card__note">note</div>
    </div>
  `);
  const card = dom.window.document.querySelector('.card');
  const row = { key: 'row-1', ticker: 'AAPL', name: 'Apple' };
  const stateApi = createCardStateApi();
  const stateFacades = createOrderStateFacades(stateApi);
  const invokes = [];
  const restorations = [];
  const renders = [];
  const updateSpreadForTicker = () => {};
  const ipcRenderer = {
    invoke: async (...args) => {
      invokes.push(args);
      return true;
    }
  };
  const adapter = createLegacyRowPresentationAdapter({
    rowByKey: key => (key === row.key ? row : undefined),
    cardByKey: key => (key === row.key ? card : null),
    rowKey: value => value.key,
    stateApi,
    stateFacades,
    handlerForKey: () => handler,
    ipcRenderer,
    render: () => renders.push('render'),
    toast: () => {},
    shakeCard: () => {},
    notifyCardRestored: args => restorations.push(args),
    updateSpreadForTicker
  });
  return {
    adapter,
    card,
    dom,
    handler,
    invokes,
    renders,
    restorations,
    row,
    stateApi,
    stateFacades,
    updateSpreadForTicker
  };
}

async function run() {
  const pending = createHarness();
  pending.card.dataset.reqId = 'req-1';
  pending.stateApi.markPendingRequest('req-1', pending.row.key, { retryCount: 3 });
  pending.adapter.setCardState(pending.row.key, 'pending');

  assert.strictEqual(pending.stateFacades.cardVisualState.getCardState(pending.row.key), 'pending');
  assert.strictEqual(pending.card.classList.contains('card--pending'), true);
  assert.strictEqual(pending.card.querySelector('.card__status').style.display, 'inline-block');
  assert.strictEqual(pending.card.querySelector('.card__status').classList.contains('card__status--pending'), true);
  assert.strictEqual(pending.card.querySelector('.card__close').style.display, 'none');
  assert.strictEqual(pending.card.querySelector('.card__spread').style.display, 'none');
  assert.strictEqual(pending.card.querySelector('.retry-btn').style.display, 'inline-block');
  assert.strictEqual(pending.card.querySelector('.retry-btn').textContent, '3');
  pending.card.querySelectorAll('input').forEach(input => assert.strictEqual(input.disabled, true));
  pending.card.querySelectorAll('button.btn').forEach(button => assert.strictEqual(button.disabled, true));

  const pendingExec = createHarness();
  pendingExec.card.dataset.reqId = 'req-2';
  pendingExec.stateApi.setPendingExecLabel(pendingExec.row.key, 'bar-close');
  pendingExec.stateApi.markPendingRequest('req-2', pendingExec.row.key, { pendingId: 'pending-2' });
  pendingExec.adapter.setCardState(pendingExec.row.key, 'pending-exec');

  const pendingStatus = pendingExec.card.querySelector('.card__status');
  assert.strictEqual(pendingStatus.textContent, 'pe (bar-close)');
  assert.strictEqual(pendingStatus.title, 'Cancel pe');
  assert.strictEqual(pendingExec.card.querySelector('.btns').style.display, 'none');
  pendingStatus.click();
  assert.deepStrictEqual(pendingExec.invokes[0], ['pending:cancel', 'pending-2']);
  assert.strictEqual(pendingExec.stateApi.getCardState(pendingExec.row.key), undefined);
  assert.strictEqual(pendingExec.stateApi.resolvePendingKey('req-2'), undefined);
  assert.strictEqual(pendingExec.card.dataset.reqId, undefined);
  assert.strictEqual(pendingExec.card.dataset.pendingId, undefined);
  assert.deepStrictEqual(pendingExec.renders, ['render']);

  let closeContext;
  const placedHandler = {
    placedStatusTitle: 'Close placed option',
    placedButton: {
      label: 'CLOSE',
      removeClasses: ['primary'],
      addClasses: ['danger'],
      title: 'Close from button'
    },
    shouldKeepFullCardOnState: ({ state }) => state === 'placed',
    shouldEnableButtonOnState: ({ state }) => state === 'placed',
    async closePlacedOrder(context) {
      closeContext = context;
      return true;
    }
  };
  const placed = createHarness(placedHandler);
  const orderInfo = { ticket: 'ticket-1', provider: 'simulated', symbol: 'AAPL' };
  placed.stateApi.markPlacedOrder(placed.row.key, orderInfo);
  placed.adapter.setCardState(placed.row.key, 'placed');

  const placedStatus = placed.card.querySelector('.card__status');
  const placedButton = placed.card.querySelector('.btns button.btn');
  assert.strictEqual(placedStatus.title, 'Close placed option');
  assert.strictEqual(typeof placedStatus.onclick, 'function');
  assert.strictEqual(placedButton.textContent, 'CLOSE');
  assert.strictEqual(placedButton.classList.contains('primary'), false);
  assert.strictEqual(placedButton.classList.contains('danger'), true);
  assert.strictEqual(placedButton.disabled, false);
  assert.strictEqual(placedButton.title, 'Close from button');
  placedStatus.click();
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(closeContext.key, placed.row.key);
  assert.strictEqual(closeContext.row, placed.row);
  assert.deepStrictEqual(closeContext.orderInfo, orderInfo);
  assert.strictEqual(closeContext.pendingRequestLabels, placed.stateFacades.pendingRequestLabels);
  assert.strictEqual(closeContext.placedOrderLookup, placed.stateFacades.placedOrderLookup);
  assert.strictEqual(closeContext.cardVisualState, placed.stateFacades.cardVisualState);
  assert.strictEqual(closeContext.ticketBinding, placed.stateFacades.ticketBinding);
  assert.strictEqual(closeContext.setCardState, placed.adapter.setCardState);

  const resetCalls = [];
  const restored = createHarness({
    resetButtons(button) {
      resetCalls.push(button);
      button.textContent = 'OPEN';
    }
  });
  restored.stateApi.markPlacedOrder(restored.row.key, { ticket: 'old-ticket' });
  restored.adapter.setCardState(restored.row.key, 'profit');
  assert.strictEqual(restored.card.classList.contains('card--mini'), true);
  assert.strictEqual(restored.card.querySelector('.btns'), null);
  assert.strictEqual(restored.card.querySelector('.quad-line'), null);

  restored.adapter.setCardState(restored.row.key, null);
  assert.strictEqual(restored.card.classList.contains('card--mini'), false);
  assert(restored.card.querySelector('.btns'));
  assert(restored.card.querySelector('.quad-line'));
  restored.card.querySelectorAll('input').forEach(input => assert.strictEqual(input.disabled, false));
  restored.card.querySelectorAll('button.btn').forEach(button => assert.strictEqual(button.disabled, false));
  assert.strictEqual(resetCalls.length, 1);
  assert.strictEqual(restored.stateApi.getPlacedOrder(restored.row.key), undefined);
  assert.strictEqual(restored.restorations.length, 1);
  assert.strictEqual(restored.restorations[0].card, restored.card);
  assert.strictEqual(restored.restorations[0].updateSpreadForTicker, restored.updateSpreadForTicker);

  console.log('cardRuntimeLegacyRowPresentation tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
