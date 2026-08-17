const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping levelOrderRenderer test');
  process.exit(0);
}
const Module = require('module');

function levelOrderSnapshot(id = 'pos-level-1', patch = {}) {
  const state = patch.state || 'draft';
  const actions = patch.actions || [
    { id: 'LB', label: 'LB', command: 'position.levelOrder.buy', style: 'bl' },
    { id: 'LS', label: 'LS', command: 'position.levelOrder.sell', style: 'sl' }
  ];
  return {
    id,
    state,
    ticker: 'TST',
    symbol: 'TST',
    instrumentType: 'EQ',
    provider: 'simulated',
    version: 1,
    timestamps: patch.timestamps || {},
    source: {
      cardType: 'levelOrder',
      ticker: 'TST',
      event: 'levelOrder',
      time: 1,
      level: 100,
      riskUsd: 50,
      stopOffsetPts: 4,
      maxLot: 3,
      takeProfitPts: 12,
      provider: 'simulated',
      instrumentType: 'EQ'
    },
    card: {
      type: 'levelOrder',
      actions,
      data: {
        ticker: 'TST',
        symbol: 'TST',
        provider: 'simulated',
        state,
        children: patch.children || [],
        expectedChildren: patch.expectedChildren,
        tickets: patch.tickets || [],
        pnl: patch.pnl || { status: 'unavailable' },
        level: 100,
        riskUsd: 50,
        stopOffsetPts: 4,
        maxLot: 3,
        minLot: 1,
        takeProfitPts: 12,
        pointSize: 0.5
      }
    },
    children: patch.children || [],
    expectedChildren: patch.expectedChildren,
    tickets: patch.tickets || [],
    pnlSnapshot: patch.pnl || { status: 'unavailable' }
  };
}

async function run() {
  const handlers = {};
  const calls = [];
  let instrumentGetCalls = 0;
  const initialPosition = levelOrderSnapshot();
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, payload) => {
      calls.push({ ch, payload });
      if (ch === 'order-cards:list') return [
        { cardType: 'levelOrder', ticker: 'LEGACY', event: 'levelOrder', time: 1, level: 10 }
      ];
      if (ch === 'positions:list') return [initialPosition];
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'settings:restart-status') return [];
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'instrument:get') {
        instrumentGetCalls += 1;
        if (instrumentGetCalls === 1) return { quote: {}, metadata: { tickSize: 0.5 }, provider: payload.provider, symbol: payload.symbol };
        return { quote: { bid: 101, ask: 102, price: 101.5 }, metadata: { tickSize: 0.5 }, provider: payload.provider, symbol: payload.symbol };
      }
      if (ch === 'level-order:place') return {
        status: 'ok',
        provider: 'simulated',
        providerOrderId: 'level:test',
        raw: {
          plan: { childQtys: [1, 2] },
          results: [
            { requestId: `${payload.requestId}_1`, qty: 1, result: { status: 'ok', providerOrderId: 'pending:cid-1' } },
            { requestId: `${payload.requestId}_2`, qty: 2, result: { status: 'ok', providerOrderId: 'pending:cid-2' } }
          ]
        }
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
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.strictEqual(t.orderCardsRows.some(row => row.cardType === 'levelOrder'), false);
  assert.strictEqual(t.positionCardRenderers.levelOrder, undefined);
  assert.strictEqual(t.cardRuntime.positionActionHandlers.levelOrder, undefined);
  assert.strictEqual(t.cardRuntime.positionRemovalHandlers.levelOrder, undefined);
  assert.strictEqual(typeof t.cardRuntime.getCardView('level-order-body'), 'function');
  assert.strictEqual(typeof t.cardRuntime.getCardControl('level-order-actions'), 'function');
  assert.strictEqual(typeof t.cardRuntime.getCardShape('level-order-position-card'), 'function');
  const levelOrderDefinition = t.cardRuntime.resolveCardType(initialPosition, { kind: 'position' });
  assert.strictEqual(levelOrderDefinition.view, 'level-order-body');
  assert.deepStrictEqual(levelOrderDefinition.controls, ['level-order-actions']);
  assert.strictEqual(levelOrderDefinition.shape, 'level-order-position-card');
  assert.strictEqual(typeof levelOrderDefinition.onRemovePosition, 'function');
  const key = 'position|pos-level-1';
  let card = t.cardByKey(key);
  assert(card);
  assert.strictEqual(card.dataset.cardType, 'levelOrder');
  assert.deepStrictEqual(Array.from(card.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['LB', 'LS']);
  assert.strictEqual(card.querySelector('input.level').value, '100');
  assert.strictEqual(card.querySelector('input.risk').value, '50');
  assert.strictEqual(card.querySelector('input.sl').value, '4');
  assert.strictEqual(card.querySelector('input.qty').value, '3');
  assert.strictEqual(card.querySelector('input.tp').value, '12');
  assert.strictEqual(card.querySelector('input.point-size').value, '0.5');
  assert.strictEqual(document.querySelector('.card[data-ticker="LEGACY"]'), null);

  assert(calls.find(c => c.ch === 'instrument:get' && c.payload.symbol === 'TST'));
  await new Promise(resolve => setTimeout(resolve, 320));
  card = t.cardByKey(key);
  const lb = card.querySelector('button.btn[data-kind="LB"]');
  assert(instrumentGetCalls >= 2);
  assert.strictEqual(lb.disabled, false);
  lb.click();
  await new Promise(resolve => setTimeout(resolve, 20));

  const call = calls.find(c => c.ch === 'level-order:place');
  assert(call);
  assert.strictEqual(call.payload.positionId, 'pos-level-1');
  assert.strictEqual(call.payload.action, 'LB');
  assert.strictEqual(call.payload.level, 100);
  assert.strictEqual(call.payload.riskUsd, 50);
  assert.strictEqual(call.payload.stopOffsetPts, 4);
  assert.strictEqual(call.payload.maxLot, 3);
  assert.strictEqual(call.payload.takeProfitPts, 12);

  const parentRequestId = call.payload.requestId;
  assert.strictEqual(t.cardStateApi.getCardState(key), 'pending-exec');
  assert.strictEqual(t.cardStateApi.getPendingExecLabel(key), 'LB');

  handlers['execution:pending'](null, {
    reqId: `${parentRequestId}_1`,
    pendingId: 'cid-1',
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 1,
      meta: { requestId: `${parentRequestId}_1`, parentRequestId, childCount: 2 }
    }
  });
  assert.strictEqual(t.cardStateApi.getCardState(key), 'pending-exec');

  handlers['execution:result'](null, {
    reqId: `${parentRequestId}_1`,
    provider: 'simulated',
    status: 'ok',
    providerOrderId: 'ticket-1',
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 1,
      meta: { requestId: `${parentRequestId}_1`, parentRequestId, childCount: 2 }
    }
  });
  handlers['execution:result'](null, {
    reqId: `${parentRequestId}_2`,
    provider: 'simulated',
    status: 'ok',
    providerOrderId: 'ticket-2',
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 2,
      meta: { requestId: `${parentRequestId}_2`, parentRequestId, childCount: 2 }
    }
  });
  assert.strictEqual(t.cardStateApi.getCardState(key), 'pending-exec');

  handlers['position:opened'](null, {
    ticket: 'position-1',
    origOrder: { meta: { requestId: `${parentRequestId}_1`, parentRequestId, childCount: 2 } }
  });
  assert.strictEqual(t.cardStateApi.getCardState(key), 'pending-exec');
  handlers['position:opened'](null, {
    ticket: 'position-2',
    origOrder: { meta: { requestId: `${parentRequestId}_2`, parentRequestId, childCount: 2 } }
  });
  assert.strictEqual(t.cardStateApi.getCardState(key), 'pending-exec');

  const placedSnapshot = levelOrderSnapshot('pos-level-1', {
    state: 'placed',
    actions: [{ id: 'close', label: 'Close', command: 'position.close', style: 'close' }],
    expectedChildren: 2,
    tickets: ['ticket-1', 'ticket-2'],
    children: [
      { requestId: `${parentRequestId}_1`, parentRequestId, state: 'placed', ticket: 'ticket-1' },
      { requestId: `${parentRequestId}_2`, parentRequestId, state: 'placed', ticket: 'ticket-2' }
    ]
  });
  handlers['positions:changed'](null, { event: { type: 'position.placed' }, position: placedSnapshot });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(t.cardStateApi.getCardState(key), undefined);
  card = t.cardByKey(key);
  assert.deepStrictEqual(Array.from(card.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['close']);
  assert.strictEqual(card.querySelector('button.btn[data-kind="close"]').disabled, false);
  card.querySelector('button.btn[data-kind="close"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(calls.some(c => c.ch === 'execution:close-level-order-positions'));
  assert(calls.some(c => c.ch === 'positions:remove' && c.payload.reason === 'renderer.levelOrder.close'));

  const activeSnapshot = levelOrderSnapshot('pos-level-1', {
    ...placedSnapshot,
    state: 'active',
    actions: [{ id: 'close', label: 'Close', command: 'position.close', style: 'close' }],
    children: placedSnapshot.children.map(child => ({ ...child, state: 'active' }))
  });
  handlers['positions:changed'](null, { event: { type: 'position.opened' }, position: activeSnapshot });
  await new Promise(resolve => setTimeout(resolve, 0));
  card = t.cardByKey(key);
  assert.deepStrictEqual(Array.from(card.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['close']);

  const closedSnapshot = levelOrderSnapshot('pos-level-1', {
    ...activeSnapshot,
    state: 'closed',
    timestamps: { openedAt: 100, closedAt: 200 },
    actions: [{ id: 'archive', label: 'Archive', command: 'position.remove', style: 'archive' }],
    pnl: { status: 'reported', value: -5 },
    children: activeSnapshot.children.map(child => ({ ...child, state: 'closed' }))
  });
  handlers['positions:changed'](null, { event: { type: 'position.closed' }, position: closedSnapshot });
  await new Promise(resolve => setTimeout(resolve, 0));
  card = t.cardByKey(key);
  assert.deepStrictEqual(Array.from(card.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['archive']);
  assert.strictEqual(card.querySelector('button.btn[data-kind="archive"]').disabled, false);
  card.querySelector('button.btn[data-kind="archive"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(calls.some(c => c.ch === 'positions:remove' && c.payload.reason === 'renderer.levelOrder.archive'));

  Module._load = originalLoad;
  console.log('levelOrderRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
