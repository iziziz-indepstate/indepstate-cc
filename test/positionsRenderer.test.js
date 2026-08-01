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
      if (ch === 'orders:list') return [];
      if (ch === 'positions:list') return [initialPosition];
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'settings:restart-status') return [];
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'instrument:get') return { quote: { bid: 0.163, ask: 0.165 }, metadata: { tickSize: 0.001 }, provider: payload.provider, symbol: payload.symbol };
      if (ch === 'level-order:place') return { status: 'ok', providerOrderId: 'level:test' };
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

  handlers['orders:new'](null, {
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
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(t.positionsById.has('pos-1'), true);
  assert(document.querySelector('.position-card[data-position-id="pos-1"]'));
  assert.strictEqual(document.querySelector('.card[data-ticker="ADAUSDT"]:not(.position-card)'), null);

  card.querySelector('.card__close').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const removeCall = calls.find(call => call.ch === 'positions:remove' && call.payload.positionId === 'pos-1');
  assert(removeCall);
  assert(document.querySelector('.position-card[data-position-id="pos-1"]'));

  handlers['positions:changed'](null, {
    event: { type: 'position.removed', positionId: 'pos-1' },
    position: t.positionsById.get('pos-1')
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(t.positionsById.has('pos-1'), false);
  assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-1"]'), null);
  assert.strictEqual(document.querySelector('.card[data-ticker="ADAUSDT"]'), null);

  Module._load = originalLoad;
  console.log('positionsRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
