const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping optionstratLegacyDedupeRenderer test');
  process.exit(0);
}
const Module = require('module');

function optionRow() {
  return {
    ticker: 'SPY',
    symbol: 'SPY',
    cardType: 'option',
    event: 'optionstrat',
    time: 1,
    instrumentType: 'OPT',
    provider: 'optionstrat',
    requestId: 'req-opt-1',
    name: 'LCS 755/756',
    strategyCommand: 'lcs',
    expirationDte: '0DTE',
    legs: [
      { option: 'CALL', side: 'buy', strike: 755, quantity: 1 },
      { option: 'CALL', side: 'sell', strike: 756, quantity: 1 }
    ],
    payoff: {
      maxProfit: 100,
      maxLoss: 200,
      isMaxProfitInfinite: false,
      isMaxLossInfinite: false
    },
    valuation: {
      initialValue: 200,
      currentValue: 240,
      change: 40,
      changePct: 20
    }
  };
}

function optionPosition(row = optionRow(), state = 'placed') {
  return {
    id: 'pos-opt-1',
    state,
    ticker: row.ticker,
    symbol: row.symbol,
    instrumentType: 'OPT',
    provider: row.provider,
    version: 1,
    tickets: ['deal-1'],
    source: {
      ...row,
      cardType: 'option',
      providerOrderId: 'deal-1'
    },
    card: {
      type: 'option',
      actions: state === 'draft'
        ? [{ id: 'BL', label: 'BL', command: 'position.open', style: 'bl' }]
        : [{ id: 'close', label: 'Close', command: 'position.close', style: 'close' }],
      data: {
        ticker: row.ticker,
        symbol: row.symbol,
        provider: row.provider,
        instrumentType: 'OPT',
        state,
        event: row.event,
        name: row.name,
        strategyCommand: row.strategyCommand,
        expirationDte: row.expirationDte,
        legs: row.legs,
        payoff: row.payoff,
        valuation: row.valuation,
        openedAt: 1000,
        ticket: 'deal-1',
        providerOrderId: 'deal-1'
      }
    }
  };
}

async function run() {
  const handlers = {};
  const calls = [];
  const row = optionRow();
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, payload) => {
      calls.push({ ch, payload });
      if (ch === 'orders:list') return [];
      if (ch === 'positions:list') return [optionPosition(row, 'draft')];
      if (ch === 'settings:get' && payload === 'optionstrat') return { valuationRefreshMs: 5000 };
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'settings:restart-status') return [];
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'positions:remove') return {
        ok: true,
        position: { id: payload.positionId, state: 'archived' },
        events: [{ type: 'position.archived', positionId: payload.positionId }]
      };
      if (ch === 'execution:cancel-order') return { status: 'ok' };
      if (ch === 'optionstrat:button-event') return { ok: true };
      if (ch === 'optionstrat:estimate') {
        return {
          status: 'ok',
          payoff: {
            maxProfit: 100,
            maxLoss: 200,
            isMaxProfitInfinite: false,
            isMaxLossInfinite: false
          }
        };
      }
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

  const legacyKey = t.rowKey(row);
  assert.strictEqual(document.querySelectorAll('.card').length, 1);
  assert(document.querySelector('.position-card[data-position-id="pos-opt-1"]'));

  handlers['orders:new'](null, row);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.strictEqual(document.querySelectorAll('.card').length, 1);
  assert(document.querySelector(`.card[data-rowkey="${legacyKey}"]:not(.position-card)`));
  assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-opt-1"]'), null);

  t.legacyOrderStateApi.markPendingRequest('req-opt-1', legacyKey, { retryCount: 2, pendingId: 'pending-opt-1' });
  t.legacyOrderStateApi.setPendingExecLabel(legacyKey, 'OPEN');
  t.legacyOrderStateApi.setCardState(legacyKey, 'pending');
  t.legacyOrderStateApi.bindTicket('deal-1', legacyKey);
  t.legacyOrderStateApi.markPlacedOrder(legacyKey, { provider: 'optionstrat', ticket: 'deal-1', symbol: 'SPY' });

  handlers['positions:changed'](null, {
    event: { type: 'position.failed' },
    position: optionPosition(row, 'failed')
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.strictEqual(t.state.rows.length, 1);
  assert.strictEqual(document.querySelectorAll('.card').length, 1);
  assert(document.querySelector(`.card[data-rowkey="${legacyKey}"]:not(.position-card)`));
  assert.strictEqual(document.querySelector('.position-card[data-position-id="pos-opt-1"]'), null);
  assert.strictEqual(t.legacyOrderStateApi.resolvePendingKey('req-opt-1'), undefined);
  assert.strictEqual(t.legacyOrderStateApi.getPendingId('req-opt-1'), undefined);
  assert.strictEqual(t.retryCounts.has('req-opt-1'), false);
  assert.strictEqual(t.legacyOrderStateApi.getPendingExecLabel(legacyKey), undefined);
  assert.strictEqual(t.legacyOrderStateApi.getCardState(legacyKey), undefined);
  assert.strictEqual(t.legacyOrderStateApi.resolveTicketKey('deal-1'), undefined);
  assert.strictEqual(t.legacyOrderStateApi.getPlacedOrder(legacyKey), undefined);

  document.querySelector(`.card[data-rowkey="${legacyKey}"]:not(.position-card) .card__close`).click();
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.strictEqual(t.state.rows.length, 0);
  assert.strictEqual(t.positionsById.has('pos-opt-1'), false);
  assert.strictEqual(document.querySelectorAll('.card').length, 0);
  assert(calls.some(call => call.ch === 'positions:remove' && call.payload.positionId === 'pos-opt-1'));

  handlers['orders:new'](null, row);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(document.querySelectorAll('.card').length, 1);
  assert(document.querySelector(`.card[data-rowkey="${legacyKey}"]:not(.position-card)`));

  t.legacyOrderStateApi.markPendingRequest('req-opt-1', legacyKey, { retryCount: 2, pendingId: 'pending-opt-1' });
  t.legacyOrderStateApi.setPendingExecLabel(legacyKey, 'OPEN');
  t.legacyOrderStateApi.setCardState(legacyKey, 'pending');
  t.legacyOrderStateApi.bindTicket('deal-1', legacyKey);
  t.legacyOrderStateApi.markPlacedOrder(legacyKey, { provider: 'optionstrat', ticket: 'deal-1', symbol: 'SPY' });

  handlers['positions:changed'](null, {
    event: { type: 'position.placed' },
    position: optionPosition(row)
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.strictEqual(t.state.rows.length, 0);
  assert.strictEqual(document.querySelectorAll('.card').length, 1);
  assert.strictEqual(document.querySelectorAll('.position-card').length, 1);
  const placedCard = document.querySelector('.position-card[data-position-id="pos-opt-1"]');
  assert(placedCard);
  assert.strictEqual(placedCard.dataset.cardType, 'option');
  assert.strictEqual(placedCard.querySelector('.card__status').textContent, '');
  assert(placedCard.textContent.includes('SPY 0DTE +1C755/-1C756'));
  assert(placedCard.textContent.includes('Max Loss'));
  assert(placedCard.textContent.includes('Max Profit'));
  assert(placedCard.textContent.includes('RR'));
  assert.strictEqual(placedCard.querySelector('.position-card__data'), null);
  assert.strictEqual(document.querySelector(`.card[data-rowkey="${legacyKey}"]:not(.position-card)`), null);
  assert.strictEqual(t.legacyOrderStateApi.resolvePendingKey('req-opt-1'), undefined);
  assert.strictEqual(t.legacyOrderStateApi.getPendingId('req-opt-1'), undefined);
  assert.strictEqual(t.retryCounts.has('req-opt-1'), false);
  assert.strictEqual(t.legacyOrderStateApi.getPendingExecLabel(legacyKey), undefined);
  assert.strictEqual(t.legacyOrderStateApi.getCardState(legacyKey), undefined);
  assert.strictEqual(t.legacyOrderStateApi.resolveTicketKey('deal-1'), undefined);
  assert.strictEqual(t.legacyOrderStateApi.getPlacedOrder(legacyKey), undefined);

  const duplicateRow = {
    ...row,
    requestId: 'req-opt-2',
    time: 2
  };
  handlers['orders:new'](null, duplicateRow);
  await new Promise(resolve => setTimeout(resolve, 20));
  const duplicateKey = t.rowKey(duplicateRow);
  const duplicateCard = document.querySelector(`.card[data-rowkey="${duplicateKey}"]:not(.position-card)`);
  assert(duplicateCard);
  assert.strictEqual(duplicateCard.dataset.instrumentType, 'OPT');
  assert(duplicateCard.textContent.includes('SPY 0DTE +1C755/-1C756'));
  assert.strictEqual(document.querySelectorAll('.position-card').length, 1);

  duplicateCard.querySelector('.card__close').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(document.querySelector(`.card[data-rowkey="${duplicateKey}"]:not(.position-card)`), null);

  const noIdentityRow = {
    ...row,
    requestId: 'req-opt-3',
    time: 3
  };
  handlers['orders:new'](null, noIdentityRow);
  await new Promise(resolve => setTimeout(resolve, 20));
  const noIdentityKey = t.rowKey(noIdentityRow);
  assert(document.querySelector(`.card[data-rowkey="${noIdentityKey}"]:not(.position-card)`));

  const noIdentityPosition = optionPosition(noIdentityRow);
  noIdentityPosition.id = 'pos-opt-2';
  noIdentityPosition.tickets = ['deal-2'];
  noIdentityPosition.primaryTicket = 'deal-2';
  noIdentityPosition.source = {
    ticker: noIdentityRow.ticker,
    symbol: noIdentityRow.symbol,
    provider: noIdentityRow.provider,
    instrumentType: 'OPT',
    cardType: 'option',
    name: noIdentityRow.name,
    expirationDte: noIdentityRow.expirationDte,
    legs: noIdentityRow.legs
  };
  delete noIdentityPosition.card.data.ticket;
  delete noIdentityPosition.card.data.providerOrderId;
  handlers['positions:changed'](null, {
    event: { type: 'position.placed' },
    position: noIdentityPosition
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(document.querySelector(`.card[data-rowkey="${noIdentityKey}"]:not(.position-card)`), null);
  assert(document.querySelector('.position-card[data-position-id="pos-opt-2"]'));

  placedCard.querySelector('button.btn[data-kind="close"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(calls.some(call => call.ch === 'execution:cancel-order'
    && call.payload.provider === 'optionstrat'
    && call.payload.ticket === 'deal-1'
    && call.payload.symbol === 'SPY'
    && call.payload.name === 'LCS 755/756'));

  Module._load = originalLoad;
  console.log('optionstratLegacyDedupeRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
