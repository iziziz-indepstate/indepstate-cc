const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping levelOrderRenderer test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const handlers = {};
  const calls = [];
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, payload) => {
      calls.push({ ch, payload });
      if (ch === 'orders:list') return [];
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'instrument:get') return { bid: 101, ask: 102, price: 101.5, tickSize: 0.5 };
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
    if (request === 'electron') {
      return { ipcRenderer };
    }
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  const renderer = require('../app/renderer.js');
  const orderCalculator = require('../app/services/orderCalculator');
  const t = renderer.__testing;
  await new Promise(resolve => setTimeout(resolve, 0));
  orderCalculator.configure({
    profitRate: 3,
    riskUsd: {
      byInstrumentType: { EQ: 50, FX: 40, CX: 0.2 },
      bySymbol: { TSTSYMBOL: 7, TSTREGULAR: 8 }
    }
  });
  t.setLevelOrderConfig({
    defaults: { maxLot: 3, stopOffsetPts: 4, takeProfitPts: 12, buyPriceSource: 'bid', sellPriceSource: 'bid' },
    symbols: [{ ticker: 'TSTMID', buyPriceSource: 'mid', sellPriceSource: 'bid' }]
  });

  const row = { cardType: 'levelOrder', ticker: 'TST', event: 'levelOrder', time: 0, level: 100, provider: 'simulated', instrumentType: 'EQ' };
  handlers['orders:new'](null, row);
  const key = t.rowKey(row);
  let card = t.cardByKey(key);
  let buttons = Array.from(card.querySelectorAll('button.btn'));
  assert.deepStrictEqual(buttons.map(b => b.dataset.kind), ['LB', 'LS']);
  assert.strictEqual(buttons[0].disabled, true);
  assert.strictEqual(card.querySelector('.card__note').textContent, 'Bid quote required');

  t.instrumentInfo.set('TST', { bid: 101, ask: 102, price: 101.5, tickSize: 0.5 });
  t.render();
  card = t.cardByKey(key);
  buttons = Array.from(card.querySelectorAll('button.btn'));
  assert.strictEqual(buttons[0].disabled, false);
  const pointSizeInput = card.querySelector('input.point-size');
  assert(pointSizeInput);
  assert.strictEqual(pointSizeInput.value, '');
  const inputs = Array.from(card.querySelectorAll('.level-order-line input.num'));
  assert.deepStrictEqual(inputs.map(i => i.value), ['100', '50', '4', '3', '12']);
  pointSizeInput.value = '0.001';
  pointSizeInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  buttons[0].click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const call = calls.find(c => c.ch === 'level-order:place');
  assert(call);
  assert.strictEqual(call.payload.action, 'LB');
  assert.strictEqual(call.payload.level, 100);
  assert.strictEqual(call.payload.riskUsd, 50);
  assert.strictEqual(call.payload.stopOffsetPts, 4);
  assert.strictEqual(call.payload.maxLot, 3);
  assert.strictEqual(call.payload.minLot, 1);
  assert.strictEqual(call.payload.takeProfitPts, 12);
  assert.strictEqual(call.payload.buyPriceSource, 'bid');
  assert.strictEqual(call.payload.sellPriceSource, 'bid');
  assert.strictEqual(call.payload.pointSize, 0.001);
  assert.strictEqual(call.payload.tickSize, 0.001);

  const symbolRow = { cardType: 'levelOrder', ticker: 'TSTSYMBOL', event: 'levelOrder', time: 2, level: 100, provider: 'simulated', instrumentType: 'EQ' };
  handlers['orders:new'](null, symbolRow);
  let symbolCard = t.cardByKey(t.rowKey(symbolRow));
  assert.strictEqual(symbolCard.querySelector('.level-order-line input.risk').value, '7');

  const explicitRow = { cardType: 'levelOrder', ticker: 'TSTEXPLICIT', event: 'levelOrder', time: 3, level: 100, riskUsd: 11, provider: 'simulated', instrumentType: 'EQ' };
  handlers['orders:new'](null, explicitRow);
  let explicitCard = t.cardByKey(t.rowKey(explicitRow));
  assert.strictEqual(explicitCard.querySelector('.level-order-line input.risk').value, '11');

  const regularRow = { ticker: 'TSTREGULAR', event: 'manual', time: 4, price: 100, sl: 5, instrumentType: 'EQ' };
  handlers['orders:new'](null, regularRow);
  let regularCard = t.cardByKey(t.rowKey(regularRow));
  let regularRisk = regularCard.querySelector('.quad-line input.risk');
  assert.strictEqual(regularRisk.value, '8');
  regularRisk.value = '12';
  regularRisk.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  orderCalculator.configure({
    profitRate: 3,
    riskUsd: {
      byInstrumentType: { EQ: 60, FX: 40, CX: 0.2 },
      bySymbol: { TSTREGULAR: 9 }
    }
  });
  t.render();
  regularCard = t.cardByKey(t.rowKey(regularRow));
  regularRisk = regularCard.querySelector('.quad-line input.risk');
  assert.strictEqual(regularRisk.value, '12');

  const regularExplicitRow = { ticker: 'TSTREGEXPLICIT', event: 'manual', time: 5, price: 100, sl: 5, risk: 13, instrumentType: 'EQ' };
  handlers['orders:new'](null, regularExplicitRow);
  const regularExplicitCard = t.cardByKey(t.rowKey(regularExplicitRow));
  assert.strictEqual(regularExplicitCard.querySelector('.quad-line input.risk').value, '13');
  const parentRequestId = call.payload.requestId;
  assert.strictEqual(t.cardStates.get(key), 'pending-exec');
  assert(t.levelOrderGroups.has(parentRequestId));
  assert.strictEqual(t.levelOrderGroups.get(parentRequestId).placedReqIds.size, 0);

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
  handlers['execution:pending'](null, {
    reqId: `${parentRequestId}_2`,
    pendingId: 'cid-2',
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 2,
      meta: { requestId: `${parentRequestId}_2`, parentRequestId, childCount: 2 }
    }
  });
  assert.strictEqual(t.levelOrderPendingToGroup.get('cid-1'), parentRequestId);

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
  assert.strictEqual(t.cardStates.get(key), 'pending-exec');
  assert.strictEqual(card.querySelector('input.qty').value, '3');
  assert.strictEqual(t.levelOrderGroups.get(parentRequestId).placedReqIds.size, 1);

  handlers['execution:result'](null, {
    reqId: `${parentRequestId}_2`,
    pendingId: 'cid-2',
    provider: 'simulated',
    status: 'ok',
    providerOrderId: 'ticket-2',
    parentRequestId,
    childCount: 2,
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 2
    }
  });
  assert.strictEqual(t.levelOrderGroups.get(parentRequestId).placedReqIds.size, 2);
  assert.strictEqual(t.levelOrderGroups.get(parentRequestId).total, 2);
  assert.strictEqual(t.cardStates.get(key), 'pending-exec');
  assert(t.state.rows.some(r => r.ticker === 'TST'));

  handlers['order:cancelled'](null, { ticket: 'ticket-1', provider: 'simulated' });
  assert(t.state.rows.some(r => r.ticker === 'TST'));
  assert.strictEqual(t.cardStates.get(key), 'pending-exec');

  handlers['position:opened'](null, {
    ticket: 'position-1',
    origOrder: { meta: { requestId: `${parentRequestId}_1`, parentRequestId, childCount: 2 } }
  });
  assert.strictEqual(t.cardStates.get(key), 'pending-exec');
  handlers['position:opened'](null, {
    ticket: 'position-2',
    origOrder: { meta: { requestId: `${parentRequestId}_2`, parentRequestId, childCount: 2 } }
  });
  assert.strictEqual(t.cardStates.get(key), 'executing');

  t.cardStates.set(key, 'pending-exec');
  handlers['level-order:positions-ready'](null, {
    requestId: parentRequestId,
    expectedQty: 3,
    foundQty: 3,
    foundCids: ['cid-1', 'cid-2']
  });
  assert.strictEqual(t.cardStates.get(key), 'executing');

  const firstGroup = t.levelOrderGroups.get(parentRequestId);
  firstGroup.key = 'stale-row-key';
  t.cardStates.set(key, 'pending-exec');
  handlers['level-order:positions-ready'](null, {
    requestId: parentRequestId,
    symbol: 'TST',
    expectedQty: 3,
    foundQty: 3,
    foundCids: ['cid-1', 'cid-2']
  });
  assert.strictEqual(firstGroup.key, key);
  assert.strictEqual(t.cardStates.get(key), 'executing');

  handlers['execution:result'](null, {
    reqId: `${parentRequestId}_2`,
    pendingId: 'cid-2',
    provider: 'simulated',
    status: 'ok',
    providerOrderId: 'ticket-2',
    parentRequestId,
    childCount: 2,
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 2,
      meta: { requestId: `${parentRequestId}_2`, parentRequestId, childCount: 2 }
    }
  });
  assert.strictEqual(t.cardStates.get(key), 'executing');

  t.ticketToKey.set('migration-ticket', key);
  t.migrateKey(key, 'migrated-row-key');
  assert.strictEqual(firstGroup.key, 'migrated-row-key');
  assert.strictEqual(t.ticketToKey.get('migration-ticket'), 'migrated-row-key');
  assert.strictEqual(t.cardStates.get('migrated-row-key'), 'executing');
  t.migrateKey('migrated-row-key', key);

  const updateRow = { cardType: 'levelOrder', ticker: 'TSTUP', event: 'levelOrder', time: 10, level: 100, stopOffsetPts: 4, provider: 'simulated', instrumentType: 'EQ' };
  const updateRow2 = { cardType: 'levelOrder', ticker: 'TSTUP', event: 'levelOrder', time: 11, level: 110, stopOffsetPts: 7, provider: 'simulated', instrumentType: 'EQ' };
  t.instrumentInfo.set('TSTUP', { bid: 101, ask: 102, price: 101.5, tickSize: 0.5 });
  handlers['orders:new'](null, updateRow);
  handlers['orders:new'](null, updateRow2);
  const updatedCard = t.cardByKey(t.rowKey(updateRow2));
  assert(updatedCard);
  assert.strictEqual(updatedCard.querySelector('.level-order-line input.level').value, '110');
  assert.strictEqual(updatedCard.querySelector('.level-order-line input.sl').value, '7');

  const midRow = { cardType: 'levelOrder', ticker: 'TSTMID', event: 'levelOrder', time: 12, level: 100, provider: 'simulated', instrumentType: 'EQ' };
  t.instrumentInfo.set('TSTMID', { bid: 101, tickSize: 0.5 });
  handlers['orders:new'](null, midRow);
  const midCard = t.cardByKey(t.rowKey(midRow));
  const midButtons = Array.from(midCard.querySelectorAll('button.btn'));
  assert.strictEqual(midButtons.find(b => b.dataset.kind === 'LB').disabled, true);
  assert.strictEqual(midButtons.find(b => b.dataset.kind === 'LB').title, 'Bid/Ask quote required');
  assert.strictEqual(midButtons.find(b => b.dataset.kind === 'LS').disabled, false);
  assert.strictEqual(midCard.querySelector('.card__note').textContent, 'Bid/Ask quote required');

  const row2 = { cardType: 'levelOrder', ticker: 'TST2', event: 'levelOrder', time: 1, level: 100, provider: 'simulated', instrumentType: 'EQ' };
  t.instrumentInfo.set('TST2', { bid: 101, ask: 102, price: 101.5, tickSize: 0.5 });
  handlers['orders:new'](null, row2);
  const key2 = t.rowKey(row2);
  let card2 = t.cardByKey(key2);
  card2.querySelector('button.btn[data-kind="LB"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const call2 = calls.filter(c => c.ch === 'level-order:place').at(-1);
  const parentRequestId2 = call2.payload.requestId;
  handlers['execution:pending'](null, {
    reqId: `${parentRequestId2}_1`,
    pendingId: 'cid-3',
    order: {
      symbol: 'TST2',
      side: 'buy',
      qty: 1,
      meta: { requestId: `${parentRequestId2}_1`, parentRequestId: parentRequestId2, childCount: 2 }
    }
  });
  handlers['execution:pending'](null, {
    reqId: `${parentRequestId2}_2`,
    pendingId: 'cid-4',
    order: {
      symbol: 'TST2',
      side: 'buy',
      qty: 2,
      meta: { requestId: `${parentRequestId2}_2`, parentRequestId: parentRequestId2, childCount: 2 }
    }
  });
  handlers['execution:retry'](null, { reqId: `${parentRequestId2}_1`, pendingId: 'cid-3', count: 2 });
  assert.strictEqual(t.retryCounts.get(`${parentRequestId2}_1`), 2);
  card2 = t.cardByKey(key2);
  assert.strictEqual(card2.dataset.reqId, parentRequestId2);
  card2.querySelector('.card__status').click();
  assert(calls.find(c => c.ch === 'execution:stop-retry' && c.payload === parentRequestId2));
  assert.strictEqual(t.cardStates.get(key2), undefined);
  assert.strictEqual(t.levelOrderGroups.has(parentRequestId2), false);
  assert.strictEqual(t.levelOrderChildToGroup.has(`${parentRequestId2}_1`), false);
  assert.strictEqual(t.levelOrderPendingToGroup.has('cid-3'), false);

  const row3 = { cardType: 'levelOrder', ticker: 'TST3', event: 'levelOrder', time: 2, level: 100, provider: 'simulated', instrumentType: 'EQ' };
  t.instrumentInfo.set('TST3', { bid: 101, ask: 102, price: 101.5, tickSize: 0.5 });
  handlers['orders:new'](null, row3);
  const key3 = t.rowKey(row3);
  let card3 = t.cardByKey(key3);
  card3.querySelector('button.btn[data-kind="LB"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const call3 = calls.filter(c => c.ch === 'level-order:place').at(-1);
  const parentRequestId3 = call3.payload.requestId;
  handlers['execution:result'](null, {
    reqId: `${parentRequestId3}_1`,
    provider: 'simulated',
    status: 'ok',
    providerOrderId: 'ticket-3',
    order: {
      symbol: 'TST3',
      side: 'buy',
      qty: 1,
      meta: { requestId: `${parentRequestId3}_1`, parentRequestId: parentRequestId3, childCount: 2 }
    }
  });
  handlers['execution:result'](null, {
    reqId: `${parentRequestId3}_2`,
    provider: 'simulated',
    status: 'ok',
    providerOrderId: 'ticket-4',
    order: {
      symbol: 'TST3',
      side: 'buy',
      qty: 2,
      meta: { requestId: `${parentRequestId3}_2`, parentRequestId: parentRequestId3, childCount: 2 }
    }
  });
  assert.strictEqual(t.cardStates.get(key3), 'pending-exec');
  card3 = t.cardByKey(key3);
  card3.querySelector('.card__status').click();
  assert(calls.find(c => c.ch === 'execution:stop-retry' && c.payload === parentRequestId3));
  assert.strictEqual(t.cardStates.get(key3), undefined);
  handlers['order:cancelled'](null, { ticket: 'ticket-3', provider: 'simulated' });
  handlers['order:cancelled'](null, { ticket: 'ticket-4', provider: 'simulated' });
  assert(t.cardByKey(key3));

  const row4 = { cardType: 'levelOrder', ticker: 'TST4', event: 'levelOrder', time: 3, level: 100, provider: 'simulated', instrumentType: 'EQ' };
  t.instrumentInfo.set('TST4', { bid: 101, ask: 102, price: 101.5, tickSize: 0.5 });
  handlers['orders:new'](null, row4);
  const key4 = t.rowKey(row4);
  let card4 = t.cardByKey(key4);
  card4.querySelector('button.btn[data-kind="LB"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const call4 = calls.filter(c => c.ch === 'level-order:place').at(-1);
  const parentRequestId4 = call4.payload.requestId;
  handlers['execution:result'](null, {
    reqId: `${parentRequestId4}_1`,
    provider: 'simulated',
    status: 'ok',
    providerOrderId: 'ticket-5',
    order: {
      symbol: 'TST4',
      side: 'buy',
      qty: 1,
      meta: { requestId: `${parentRequestId4}_1`, parentRequestId: parentRequestId4, childCount: 1 }
    }
  });
  card4 = t.cardByKey(key4);
  delete card4.dataset.reqId;
  card4.querySelector('.card__status').click();
  assert(calls.find(c => c.ch === 'execution:cancel-order' && c.payload.ticket === 'ticket-5'));

  const closedRow = { ticker: 'CLOSED', event: 'manual', time: 20, provider: 'ibkr', instrumentType: 'EQ' };
  handlers['orders:new'](null, closedRow);
  const closedKey = t.rowKey(closedRow);
  t.ticketToKey.set('ibkr-parent', closedKey);
  handlers['position:closed'](null, { ticket: 'ibkr-parent', provider: 'ibkr', trade: { pnlStatus: 'unavailable' } });
  assert.strictEqual(t.cardStates.get(closedKey), 'closed');
  assert(t.cardByKey(closedKey).querySelector('.card__status').classList.contains('card__status--closed'));
  handlers['position:closed'](null, { ticket: 'ibkr-parent', provider: 'ibkr', profit: 0, trade: { profit: 0, pnlStatus: 'reported' } });
  assert.strictEqual(t.cardStates.get(closedKey), 'profit');
  handlers['position:closed'](null, { ticket: 'ibkr-parent', provider: 'ibkr', profit: -1, trade: { profit: -1, pnlStatus: 'reported' } });
  assert.strictEqual(t.cardStates.get(closedKey), 'loss');

  const groupedRow = { cardType: 'levelOrder', ticker: 'GROUPPNL', event: 'levelOrder', time: 21, level: 100, provider: 'ibkr', instrumentType: 'EQ' };
  t.instrumentInfo.set('GROUPPNL', { bid: 101, ask: 102, price: 101.5, tickSize: 0.5 });
  handlers['orders:new'](null, groupedRow);
  const groupedKey = t.rowKey(groupedRow);
  const groupedId = 'grouped-pnl';
  t.levelOrderGroups.set(groupedId, {
    parentRequestId: groupedId,
    key: groupedKey,
    total: 2,
    childReqIds: new Set(),
    placedReqIds: new Set(),
    openedTickets: new Set(['group-ticket-1', 'group-ticket-2']),
    closedTickets: new Set(),
    profitByTicket: new Map(),
    tickets: new Set(['group-ticket-1', 'group-ticket-2'])
  });
  t.levelOrderTicketToGroup.set('group-ticket-1', groupedId);
  t.levelOrderTicketToGroup.set('group-ticket-2', groupedId);
  handlers['position:closed'](null, { ticket: 'group-ticket-1', profit: 5, trade: { profit: 5, pnlStatus: 'reported' } });
  assert.notStrictEqual(t.cardStates.get(groupedKey), 'profit');
  handlers['position:closed'](null, { ticket: 'group-ticket-2', trade: { pnlStatus: 'unavailable' } });
  assert.strictEqual(t.cardStates.get(groupedKey), 'closed');
  handlers['position:closed'](null, { ticket: 'group-ticket-2', profit: -10, trade: { profit: -10, pnlStatus: 'reported' } });
  assert.strictEqual(t.cardStates.get(groupedKey), 'loss');
  handlers['position:closed'](null, { ticket: 'group-ticket-1', profit: 20, trade: { profit: 20, pnlStatus: 'reported' } });
  assert.strictEqual(t.cardStates.get(groupedKey), 'profit');

  Module._load = originalLoad;
  console.log('levelOrderRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
