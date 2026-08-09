const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping positionsRenderer test');
  process.exit(0);
}
const Module = require('module');

function levelOrderSnapshot(id, actions) {
  return {
    id,
    state: 'draft',
    ticker: 'ADAUSDT',
    symbol: 'ADAUSDT',
    instrumentType: 'CX',
    provider: 'simulated',
    version: 1,
    source: {
      cardType: 'levelOrder',
      ticker: 'ADAUSDT',
      event: 'levelOrder',
      time: 1,
      level: 0.164,
      riskUsd: 25,
      stopOffsetPts: 4,
      maxLot: 200,
      takeProfitPts: 12,
      provider: 'simulated',
      instrumentType: 'CX'
    },
    card: {
      type: 'levelOrder',
      actions,
      data: {
        ticker: 'ADAUSDT',
        symbol: 'ADAUSDT',
        provider: 'simulated',
        state: 'draft',
        level: 0.164,
        riskUsd: 25,
        stopOffsetPts: 4,
        maxLot: 200,
        minLot: 1,
        takeProfitPts: 12,
        pointSize: 0.001
      }
    }
  };
}

function regularSnapshot(id, state = 'draft', actions) {
  return {
    id,
    state,
    ticker: 'MSFT',
    symbol: 'MSFT',
    instrumentType: 'EQ',
    provider: 'simulated',
    version: state === 'draft' ? 1 : 2,
    source: {
      cardType: 'regular',
      ticker: 'MSFT',
      event: 'up',
      time: 42,
      price: 100,
      qty: 2,
      sl: 6,
      tp: 3,
      riskUsd: 10,
      provider: 'simulated',
      instrumentType: 'EQ'
    },
    card: {
      type: 'regular',
      actions: actions || [
        { id: 'BL', label: 'BL', command: 'position.open', style: 'bl' },
        { id: 'SC', label: 'SC', command: 'position.openPending', style: 'sc' }
      ],
      data: {
        ticker: 'MSFT',
        symbol: 'MSFT',
        provider: 'simulated',
        event: 'up',
        state: 'draft',
        instrumentType: 'EQ',
        price: 100,
        qty: 2,
        sl: 6,
        tp: 3,
        riskUsd: 10
      }
    }
  };
}

async function run() {
  const handlers = {};
  const calls = [];
  const initialPosition = levelOrderSnapshot('pos-1', [
    { id: 'LS', label: 'LS', command: 'position.levelOrder.sell', style: 'sl' }
  ]);
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, payload) => {
      calls.push({ ch, payload });
      if (ch === 'order-cards:list') return [];
      if (ch === 'positions:list') return [initialPosition];
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'settings:restart-status') return [];
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'instrument:get') {
        if (payload.symbol === 'MSFT') return { quote: { bid: 99.9, ask: 100.1 }, metadata: { tickSize: 1 }, provider: payload.provider, symbol: payload.symbol };
        return { quote: { bid: 0.163, ask: 0.165 }, metadata: { tickSize: 0.001 }, provider: payload.provider, symbol: payload.symbol };
      }
      if (ch === 'level-order:place') return { status: 'ok', providerOrderId: 'level:test' };
      if (ch === 'execution:cancel-order') return { status: 'ok', ticket: payload.ticket, symbol: payload.symbol };
      if (ch === 'execution:close-position') return { status: 'ok', ticket: payload.ticket, symbol: payload.symbol };
      if (ch === 'positions:remove') return {
        ok: true,
        position: { id: payload.positionId, state: 'archived' },
        events: [{ type: 'position.archived', positionId: payload.positionId }]
      };
      return {};
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer };
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div><div id="settings-restart-required"></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  const renderer = require('../app/renderer.js');
  const t = renderer.__testing;
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.strictEqual(t.positionsById.get('pos-1').card.type, 'levelOrder');
  let card = document.querySelector('.position-card[data-position-id="pos-1"]');
  assert(card);
  assert.strictEqual(card.dataset.cardType, 'levelOrder');
  assert.strictEqual(card.querySelector('.meta').textContent, '');
  assert.strictEqual(card.querySelector('.card__status').style.display, 'none');
  assert.strictEqual(card.querySelector('input.level').value, '0.164');
  assert.strictEqual(card.querySelector('input.risk').value, '25');
  assert.strictEqual(card.querySelector('input.sl').value, '4');
  assert.strictEqual(card.querySelector('input.qty').value, '200');
  assert.strictEqual(card.querySelector('input.tp').value, '12');
  assert.deepStrictEqual(Array.from(card.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['LS']);

  const updatedPosition = levelOrderSnapshot('pos-1', [
    { id: 'LB', label: 'LB', command: 'position.levelOrder.buy', style: 'bl' },
    { id: 'LS', label: 'LS', command: 'position.levelOrder.sell', style: 'sl' }
  ]);
  handlers['positions:changed'](null, { event: { type: 'position.created' }, position: updatedPosition });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepStrictEqual(t.positionsById.get('pos-1').card.actions.map(action => action.id), ['LB', 'LS']);
  card = document.querySelector('.position-card[data-position-id="pos-1"]');
  const buttons = Array.from(card.querySelectorAll('button.btn'));
  assert.deepStrictEqual(buttons.map(btn => btn.dataset.kind), ['LB', 'LS']);
  await new Promise(resolve => setTimeout(resolve, 20));
  buttons[0].click();
  await new Promise(resolve => setTimeout(resolve, 20));

  const levelOrderCall = calls.find(call => call.ch === 'level-order:place' && call.payload.positionId === 'pos-1');
  assert(levelOrderCall);
  assert(levelOrderCall.payload.requestId);
  assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-1"]').dataset.reqId, levelOrderCall.payload.requestId);
  assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-1"] .card__status').style.display, 'inline-block');
  assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-1"] .card__status').textContent, 'pe (LB)');
  assert.strictEqual(levelOrderCall.payload.action, 'LB');
  assert.strictEqual(levelOrderCall.payload.level, 0.164);
  assert.strictEqual(levelOrderCall.payload.riskUsd, 25);
  assert.strictEqual(levelOrderCall.payload.stopOffsetPts, 4);
  assert.strictEqual(levelOrderCall.payload.maxLot, 200);
  assert.strictEqual(levelOrderCall.payload.takeProfitPts, 12);

  const regularPosition = regularSnapshot('pos-reg-1');
  handlers['positions:changed'](null, { event: { type: 'position.created' }, position: regularPosition });
  await new Promise(resolve => setTimeout(resolve, 0));
  let regularCard = document.querySelector('.position-card[data-position-id="pos-reg-1"]');
  assert(regularCard);
  assert.strictEqual(regularCard.dataset.cardType, 'regular');
  assert.strictEqual(regularCard.querySelector('.card__status').style.display, 'none');
  assert.strictEqual(regularCard.querySelector('input.pr').value, '100');
  assert.deepStrictEqual(Array.from(regularCard.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['BL', 'SC']);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(calls.some(call => call.ch === 'instrument:get' && call.payload.symbol === 'MSFT'));
  regularCard = document.querySelector('.position-card[data-position-id="pos-reg-1"]');
  calls.length = 0;
  const regularBlButton = regularCard.querySelector('button.btn[data-kind="BL"]');
  assert.strictEqual(regularBlButton.disabled, false, regularBlButton.title);
  regularBlButton.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const regularOpenCall = calls.find(call => call.ch === 'queue-place-order' && call.payload.meta?.positionId === 'pos-reg-1');
  assert(regularOpenCall);
  assert.strictEqual(regularOpenCall.payload.ticker, 'MSFT');

  handlers['order-cards:changed'](null, { type: 'upsert', row: {
    cardType: 'regular',
    ticker: 'MSFT',
    event: 'up',
    time: 42,
    price: 100,
    qty: 2,
    sl: 6,
    tp: 3,
    riskUsd: 10,
    provider: 'simulated',
    instrumentType: 'EQ'
  } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(document.querySelectorAll('.position-card[data-position-id="pos-reg-1"]').length, 1);
  assert.strictEqual(document.querySelector('.card[data-ticker="MSFT"]:not(.position-card)'), null);

  const activeRegular = regularSnapshot('pos-reg-1', 'active', [
    { id: 'close', label: 'Close', command: 'position.close', style: 'close' }
  ]);
  activeRegular.primaryTicket = 'ticket-reg-1';
  activeRegular.tickets = ['ticket-reg-1'];
  activeRegular.card.data.state = 'draft';
  handlers['positions:changed'](null, { event: { type: 'position.opened' }, position: activeRegular });
  await new Promise(resolve => setTimeout(resolve, 0));
  regularCard = document.querySelector('.position-card[data-position-id="pos-reg-1"]');
  // Compact regular cards are intentionally read-only snapshots: identity/status only.
  assert.strictEqual(regularCard.classList.contains('card--mini'), true);
  assert.strictEqual(regularCard.querySelector('.card__status').textContent, '');
  assert.strictEqual(regularCard.querySelector('.card__status').classList.contains('card__status--active'), true);
  assert.strictEqual(regularCard.querySelector('.position-card__data'), null);
  assert.strictEqual(regularCard.querySelector('.position-card__actions'), null);

  const placedRegular = regularSnapshot('pos-reg-placed', 'placed', [
    { id: 'close', label: 'Close', command: 'position.close', style: 'close' }
  ]);
  placedRegular.primaryTicket = 'ticket-reg-placed';
  placedRegular.tickets = ['ticket-reg-placed'];
  handlers['positions:changed'](null, { event: { type: 'position.placed' }, position: placedRegular });
  await new Promise(resolve => setTimeout(resolve, 0));
  const placedRegularCard = document.querySelector('.position-card[data-position-id="pos-reg-placed"]');
  // Compact placed regular snapshots keep actions in metadata, not inline DOM controls.
  assert.strictEqual(placedRegularCard.querySelector('.position-card__actions'), null);

  const closedRegular = regularSnapshot('pos-reg-closed', 'closed', [
    { id: 'archive', label: 'Archive', command: 'position.remove', style: 'archive' }
  ]);
  closedRegular.primaryTicket = 'ticket-reg-closed';
  closedRegular.tickets = ['ticket-reg-closed'];
  handlers['positions:changed'](null, { event: { type: 'position.closed' }, position: closedRegular });
  await new Promise(resolve => setTimeout(resolve, 0));
  const closedRegularCard = document.querySelector('.position-card[data-position-id="pos-reg-closed"]');
  // Compact closed regular snapshots keep actions in metadata, not inline DOM controls.
  assert.strictEqual(closedRegularCard.querySelector('.position-card__actions'), null);

  handlers['positions:changed'](null, {
    event: { type: 'position.created' },
    position: {
      id: 'pos-child-1',
      state: 'opening',
      ticker: 'ADAUSDT',
      symbol: 'ADAUSDT',
      instrumentType: 'CX',
      provider: 'simulated',
      version: 1,
      source: {
        ticker: 'ADAUSDT',
        meta: {
          parentRequestId: levelOrderCall.payload.requestId,
          strategy: 'limitBidTrade'
        }
      },
      card: {
        type: 'regular',
        actions: [],
        data: {
          ticker: 'ADAUSDT',
          state: 'opening'
        }
      }
    }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(t.positionsById.has('pos-child-1'), true);
  assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-child-1"]'), null);

  handlers['order-cards:changed'](null, { type: 'upsert', row: {
    cardType: 'levelOrder',
    ticker: 'ADAUSDT',
    event: 'levelOrder',
    time: 1,
    level: 0.164,
    riskUsd: 25,
    stopOffsetPts: 4,
    maxLot: 200,
    takeProfitPts: 12,
    provider: 'simulated',
    instrumentType: 'CX'
  } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(t.positionsById.has('pos-1'), true);
  assert(document.querySelector('.position-card[data-position-id="pos-1"]'));
  assert.strictEqual(document.querySelector('.card[data-ticker="ADAUSDT"]:not(.position-card)'), null);

  const placedPosition = levelOrderSnapshot('pos-1', [
    { id: 'close', label: 'Close', command: 'position.close', style: 'close' }
  ]);
  placedPosition.state = 'placed';
  placedPosition.card.data.state = 'placed';
  placedPosition.expectedChildren = 2;
  placedPosition.tickets = ['ticket-1', 'ticket-2'];
  placedPosition.children = [
    { requestId: `${levelOrderCall.payload.requestId}_1`, parentRequestId: levelOrderCall.payload.requestId, state: 'placed', ticket: 'ticket-1' },
    { requestId: `${levelOrderCall.payload.requestId}_2`, parentRequestId: levelOrderCall.payload.requestId, state: 'placed', ticket: 'ticket-2' }
  ];
  placedPosition.card.data.expectedChildren = 2;
  placedPosition.card.data.tickets = placedPosition.tickets;
  placedPosition.card.data.children = placedPosition.children;
  handlers['positions:changed'](null, { event: { type: 'position.placed' }, position: placedPosition });
  await new Promise(resolve => setTimeout(resolve, 0));
  card = document.querySelector('.position-card[data-position-id="pos-1"]');
  assert.deepStrictEqual(Array.from(card.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['close']);
  assert.strictEqual(document.querySelector('.card[data-ticker="ADAUSDT"]:not(.position-card)'), null);

  const closedPosition = {
    ...placedPosition,
    state: 'closed',
    timestamps: { openedAt: 100, closedAt: 200 },
    card: {
      ...placedPosition.card,
      actions: [{ id: 'archive', label: 'Archive', command: 'position.remove', style: 'archive' }],
      data: { ...placedPosition.card.data, state: 'closed', pnl: { status: 'reported', value: 12 } }
    },
    pnlSnapshot: { status: 'reported', value: 12 }
  };
  handlers['positions:changed'](null, { event: { type: 'position.closed' }, position: closedPosition });
  await new Promise(resolve => setTimeout(resolve, 0));
  card = document.querySelector('.position-card[data-position-id="pos-1"]');
  assert.deepStrictEqual(Array.from(card.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['archive']);

  const preOpenClosedPosition = {
    ...placedPosition,
    id: 'pos-preopen-closed',
    state: 'closed',
    timestamps: { openedAt: null, closedAt: 300 },
    card: {
      ...placedPosition.card,
      actions: [{ id: 'archive', label: 'Archive', command: 'position.remove', style: 'archive' }],
      data: { ...placedPosition.card.data, state: 'closed' }
    }
  };
  t.legacyOrderStateApi.setCardState('position|pos-preopen-closed', 'closed');
  handlers['positions:changed'](null, { event: { type: 'position.closed' }, position: preOpenClosedPosition });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preOpenCard = document.querySelector('.position-card[data-position-id="pos-preopen-closed"]');
  assert(preOpenCard);
  assert.deepStrictEqual(Array.from(preOpenCard.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['archive']);
  assert.strictEqual(t.positionsById.get('pos-preopen-closed').state, 'closed');
  assert.strictEqual(t.legacyOrderStateApi.getCardState('position|pos-preopen-closed'), undefined);

  calls.length = 0;
  card = document.querySelector('.position-card[data-position-id="pos-1"]');
  card.querySelector('.card__close').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const removeCall = calls.find(call => call.ch === 'positions:remove' && call.payload.positionId === 'pos-1');
  assert(removeCall);
  assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-1"]'), null);

  handlers['positions:changed'](null, {
    event: { type: 'position.removed', positionId: 'pos-1' },
    position: t.positionsById.get('pos-1')
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(t.positionsById.has('pos-1'), false);
  assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-1"]'), null);
  assert.strictEqual(document.querySelector('.card[data-position-id="pos-1"]'), null);

  Module._load = originalLoad;
  console.log('positionsRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
