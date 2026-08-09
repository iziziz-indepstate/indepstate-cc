const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping optionstratRenderer test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const originalDateNow = Date.now;
  const handlers = {};
  const cancelled = [];
  const buttonEvents = [];
  const queuedOrders = [];
  const estimates = [];
  const valuations = [];
  const savedSettings = [];
  const payoff = {
    maxProfit: 100,
    maxLoss: 900,
    isMaxProfitInfinite: false,
    isMaxLossInfinite: false
  };
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, payload, data) => {
      if (ch === 'orders:list') return [];
      if (ch === 'settings:get' && payload === 'optionstrat') return { valuationRefreshMs: 5000 };
      if (ch === 'settings:get') return { autoscroll: true };
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') {
        savedSettings.push({ name: payload, data });
        return true;
      }
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'optionstrat:button-event') {
        buttonEvents.push(payload);
        return { ok: true };
      }
      if (ch === 'queue-place-order') {
        queuedOrders.push(payload);
        return { status: 'ok', provider: 'optionstrat', providerOrderId: 'deal-open', payoff };
      }
      if (ch === 'execution:cancel-order') {
        cancelled.push(payload);
        return {
          status: 'ok',
          valuation: {
            initialValue: 900,
            currentValue: 970,
            change: 70,
            changePct: 7.78
          }
        };
      }
      if (ch === 'optionstrat:estimate') {
        estimates.push(payload);
        return { status: 'ok', payoff };
      }
      if (ch === 'optionstrat:valuation') {
        valuations.push(payload);
        return {
          status: 'ok',
          valuation: {
            initialValue: 900,
            currentValue: 950,
            change: 50,
            changePct: 5.56
          }
        };
      }
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
  await new Promise(resolve => setImmediate(resolve));
  const t = renderer.__testing;
  const row = {
    ticker: 'SPY',
    symbol: 'SPY',
    event: 'optionstrat',
    time: 1,
    price: undefined,
    instrumentType: 'OPT',
    provider: 'optionstrat',
    strategyCommand: 'lcs',
    name: 'BCS 755/756',
    expirationDte: '0DTE',
    legs: [
      { option: 'CALL', side: 'buy', strike: 755, quantity: 10 },
      { option: 'CALL', side: 'sell', strike: 756, quantity: 10 }
    ]
  };

  handlers['orders:new'](null, row);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const key = t.rowKey(row);
  let card = t.cardByKey(key);
  assert.strictEqual(estimates.length, 1);
  assert.strictEqual(estimates[0].ticker, 'SPY');
  assert.deepStrictEqual(estimates[0].legs, row.legs);
  assert(card.textContent.includes('Max Loss $900'));
  assert(card.textContent.includes('Max Profit $100'));
  assert(card.textContent.includes('RR 1:0.1'));
  assert(card.textContent.includes('SPY 0DTE +10C755/-10C756'));
  assert.strictEqual(card.querySelector('button.btn').textContent, 'OPEN');
  card.querySelector('button.btn').click();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(buttonEvents.length, 1);
  assert.strictEqual(buttonEvents[0].action, 'open');
  assert.strictEqual(buttonEvents[0].row.strategyCommand, 'lcs');
  assert.strictEqual(queuedOrders.length, 1);
  assert.strictEqual(queuedOrders[0].side, 'OPEN');
  assert.strictEqual(queuedOrders[0].event, 'optionstrat');
  assert.strictEqual(queuedOrders[0].time, 1);
  assert.strictEqual(queuedOrders[0].instrumentType, 'OPT');
  assert.deepStrictEqual(queuedOrders[0].legs, row.legs);
  assert.strictEqual(queuedOrders[0].expirationDte, '0DTE');
  assert.strictEqual(queuedOrders[0].meta.qty, 1);
  assert.strictEqual(queuedOrders[0].meta.stopPts, 1);
  assert.strictEqual(queuedOrders[0].meta.takePts, null);
  assert.strictEqual(t.legacyOrderStateApi.resolveTicketKey('deal-open'), key);
  assert.strictEqual(t.legacyOrderStateApi.getPlacedOrder(key).ticket, 'deal-open');
  assert.strictEqual(t.legacyOrderStateApi.getPlacedOrder(key).payoff, payoff);
  assert.strictEqual(row.payoff, payoff);
  assert(Number.isFinite(row.openedAt));
  assert.strictEqual(t.legacyOrderStateApi.getCardState(key), 'placed');

  t.legacyOrderStateApi.markPlacedOrder(key, { provider: 'optionstrat', ticket: 'deal-1', symbol: 'SPY', name: row.name, strategyCommand: 'lcs', payoff });
  t.legacyOrderStateApi.bindTicket('deal-1', key);
  row.valuation = { initialValue: 900, currentValue: 950, change: 50, changePct: 5.56 };
  row.openedAt = Date.UTC(2026, 5, 13, 9, 30);
  t.setCardState(key, 'placed');
  t.render();
  card = t.cardByKey(key);
  let closeButton = card.querySelector('button.btn');
  assert.strictEqual(closeButton.textContent, 'CLOSE');
  assert(card.textContent.includes('P/L $50'));
  assert(card.textContent.includes('Change +5.6%'));
  assert(card.textContent.includes('Value $950'));
  assert(card.textContent.includes('Opened '));
  assert(!card.textContent.includes('Closed '));
  Date.now = () => Date.UTC(2026, 5, 13, 10, 45);
  closeButton.click();
  await new Promise(resolve => setImmediate(resolve));
  Date.now = originalDateNow;
  assert.strictEqual(buttonEvents.length, 2);
  assert.strictEqual(buttonEvents[1].action, 'close');
  assert.strictEqual(buttonEvents[1].row.strategyCommand, 'lcs');
  assert.deepStrictEqual(cancelled, [{ provider: 'optionstrat', ticket: 'deal-1', symbol: 'SPY', name: 'BCS 755/756' }]);
  card = t.cardByKey(key);
  assert(card.querySelector('.card__status').classList.contains('card__status--profit'));
  assert.strictEqual(card.querySelector('.btns').style.display, 'none');
  assert(card.textContent.includes('P/L $70'));
  assert(card.textContent.includes('Change +7.8%'));
  assert(card.textContent.includes('Value $970'));
  assert(card.textContent.includes('Closed '));
  const detailsText = card.querySelector('.option-details').textContent;
  assert(detailsText.indexOf('Change ') < detailsText.indexOf('RR '));
  assert(detailsText.indexOf('RR ') < detailsText.indexOf('Opened '));
  assert(detailsText.indexOf('Opened ') < detailsText.indexOf('Closed '));
  assert.strictEqual(t.legacyOrderStateApi.getPlacedOrder(key), undefined);

  t.setCardState(key, 'profit');
  card = t.cardByKey(key);
  assert.strictEqual(card.querySelector('.btns').style.display, 'none');
  assert(card.textContent.includes('Max Loss $900'));
  const settingsRuntime = require('../app/services/settings');
  await settingsRuntime.applyConfig('optionstrat', {
    displayFields: {
    pl: false,
    value: false,
    maxLoss: false,
    maxProfit: false,
    change: false,
    rr: false
    }
  }, ['displayFields']);
  t.render();
  card = t.cardByKey(key);
  assert(!card.textContent.includes('P/L $70'));
  assert(!card.textContent.includes('Change +7.8%'));
  assert(!card.textContent.includes('Value $970'));
  assert(!card.textContent.includes('Max Loss $900'));
  assert(!card.textContent.includes('Max Profit $100'));
  assert(!card.textContent.includes('RR 1:0.1'));
  assert(card.textContent.includes('Opened '));
  assert(card.textContent.includes('Closed '));
  const settingsPanel = document.getElementById('settings-panel');
  const settingsForm = document.createElement('form');
  settingsForm.dataset.dirty = '1';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = false;
  input.dataset.field = 'displayFields.pl';
  settingsForm.appendChild(input);
  settingsPanel.style.display = 'flex';
  t.settingsForms.set('optionstrat', settingsForm);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(settingsPanel.style.display, 'none');
  assert.deepStrictEqual(savedSettings[savedSettings.length - 1], {
    name: 'optionstrat',
    data: { displayFields: { pl: false } }
  });
  assert.strictEqual(t.settingsForms.size, 0);
  Date.now = originalDateNow;
  console.log('optionstratRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
