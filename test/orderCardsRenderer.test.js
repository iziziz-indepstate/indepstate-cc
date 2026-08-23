const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createOrderCardsRenderer } = require('../app/services/orderCards/renderer');
const { createCardRuntimeLibrary } = require('../app/infrastructure/renderer/cardRuntime/library');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) {}

function createRenderer(overrides = {}) {
  return createOrderCardsRenderer({
    el: () => ({}),
    inputNumber: () => ({ addEventListener() {}, classList: { toggle() {} }, value: '' }),
    uiState: new Map(),
    orderCalc: {
      defaultRiskUsd: () => 10,
      qty: () => 1,
      takePts: value => value * 3
    },
    priceToPoints: () => 1,
    normNum: value => Number(value),
    isPos: value => Number.isFinite(value) && value > 0,
    isSL: value => Number.isFinite(value) && value > 0,
    tickSize: () => 0.01,
    instrumentInfoFor: () => ({}),
    markTouched: () => {},
    detectInstrumentType: () => 'EQ',
    rowKey: row => `${row.ticker}|${row.event}|${row.time}|${row.price}`,
    ipcRenderer: { invoke: async () => ({ status: 'ok' }) },
    orderStateApi: {
      markPendingRequest: () => true,
      setPendingExecLabel: () => true,
      setPendingId: () => true
    },
    cardByKey: () => null,
    setCardState: () => {},
    pendingActionInfo: () => null,
    toast: () => {},
    shakeCard: () => {},
    render: () => {},
    ...overrides
  });
}

async function run() {
  const renderer = createRenderer();
  assert.strictEqual(typeof renderer.createRegularPositionCard, 'function');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(renderer, 'createLegacyOrderCard'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(renderer, 'registerInstrumentHandler'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(renderer, 'registerCardTypeHandler'), false);

  if (JSDOM) {
    const dom = new JSDOM('<!DOCTYPE html><div id="grid"></div>');
    global.document = dom.window.document;
    const calls = [];
    const states = [];
    const uiState = new Map();
    const domEl = (tag, className, text, attrs) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      if (attrs) Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
      return node;
    };
    const domBtn = (text, className, onClick) => {
      const button = document.createElement('button');
      button.className = `btn ${className}`;
      button.textContent = text;
      button.addEventListener('click', onClick);
      return button;
    };
    const shapeCalls = [];
    const baseLibrary = createCardRuntimeLibrary({ el: domEl, btn: domBtn, document });
    const cardRuntimeLibrary = {
      ...baseLibrary,
      shapes: {
        createPositionCardShape(options) {
          shapeCalls.push(['position', options]);
          return baseLibrary.shapes.createPositionCardShape(options);
        }
      }
    };
    let legacyTradeRulesCalls = 0;
    const domRenderer = createRenderer({
      el: domEl,
      inputNumber: (ph, cls) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.placeholder = ph;
        input.className = cls ? `num ${cls}` : 'num';
        return input;
      },
      uiState,
      tradeRules: {
        validate: () => {
          legacyTradeRulesCalls += 1;
          return { ok: false, reason: 'Qty step mismatch' };
        }
      },
      ipcRenderer: {
        invoke: async (ch, payload) => {
          calls.push({ ch, payload });
          if (ch === 'execution:preview-place-order') return { ok: true, status: 'ok' };
          return { status: 'ok', providerOrderId: 'ticket-1' };
        }
      },
      cardByKey: key => document.querySelector(`.card[data-rowkey="${key}"]`),
      setCardState: (key, state) => states.push({ key, state }),
      now: () => 10,
      random: () => 0.5,
      btn: domBtn,
      cardRuntimeLibrary,
      getCardButtons: () => [{ label: 'BL', action: 'BL', style: 'bl' }]
    });
    const card = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-1',
        state: 'draft',
        ticker: 'MSFT',
        instrumentType: 'EQ',
        provider: 'simulated',
        card: {
          type: 'regular',
          actions: [{ id: 'BL', label: 'BL', command: 'position.open', style: 'bl' }],
          data: {
            ticker: 'MSFT',
            instrumentType: 'EQ',
            provider: 'simulated',
            event: 'up',
            price: 100,
            qty: 2,
            sl: 1,
            tp: 3,
            riskUsd: 10
          }
        }
      },
      key: 'position|pos-reg-1',
      title: 'MSFT'
    });
    document.getElementById('grid').appendChild(card);
    assert.strictEqual(card.dataset.cardType, 'regular');
    assert.strictEqual(card.querySelector('.card__status').style.display, 'none');
    assert.strictEqual(card.querySelector('input.qty').value, '1');
    assert.deepStrictEqual(Array.from(card.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['BL']);
    assert.strictEqual(shapeCalls.some(([type, options]) => (
      type === 'position' && options.attributes['data-card-type'] === 'regular'
    )), true);
    card.querySelector('button.btn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepStrictEqual(calls.map(call => call.ch), [
      'execution:preview-place-order',
      'queue-place-order'
    ]);
    assert.strictEqual(legacyTradeRulesCalls, 0);
    assert.strictEqual(calls[0].payload.ticker, 'MSFT');
    assert.strictEqual(calls[0].payload.kind, 'BL');
    assert.strictEqual(calls[0].payload.instrumentType, 'EQ');
    assert.strictEqual(calls[0].payload.tickSize, 0.01);
    assert.strictEqual(typeof calls[0].payload.meta.requestId, 'string');
    assert.strictEqual(calls[0].payload.meta.requestId.length > 0, true);
    assert.strictEqual(calls[0].payload.meta.positionId, 'pos-reg-1');
    assert.strictEqual(calls[0].payload, calls[1].payload);
    assert.strictEqual(states[0].key, 'position|pos-reg-1');

    const closed = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-2',
        state: 'closed',
        primaryTicket: 'ticket-2',
        tickets: ['ticket-2'],
        pnlSnapshot: { status: 'reported', value: 5 },
        card: {
          type: 'regular',
          actions: [{ id: 'archive', label: 'Archive', command: 'position.remove', style: 'archive' }],
          data: { ticker: 'MSFT', price: 100, qty: 2, state: 'draft' }
        }
      },
      key: 'position|pos-reg-2',
      title: 'MSFT'
    });
    // Compact closed regular cards are read-only snapshots; action metadata is retained separately.
    assert.strictEqual(closed.querySelector('.card__status').textContent, '');
    assert.strictEqual(closed.querySelector('.card__status').classList.contains('card__status--closed'), true);
    assert.strictEqual(closed.classList.contains('card--mini'), true);
    assert.strictEqual(closed.querySelector('.position-card__data'), null);
    assert.strictEqual(closed.querySelector('.position-card__actions'), null);
    assert.deepStrictEqual(closed._positionActions.map(action => action.label), ['Archive']);
    assert.strictEqual(closed.querySelector('input'), null);

    const active = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-active',
        state: 'active',
        primaryTicket: 'ticket-active',
        card: {
          type: 'regular',
          actions: [{ id: 'close', label: 'Close', command: 'position.close', style: 'close' }],
          data: { ticker: 'MSFT', price: 100 }
        }
      },
      key: 'position|pos-reg-active',
      title: 'MSFT'
    });
    // Compact active regular cards intentionally omit inline action controls.
    assert.strictEqual(active.classList.contains('card--mini'), true);
    assert.strictEqual(active.querySelector('.position-card__actions'), null);
    assert.deepStrictEqual(active._positionActions.map(action => action.label), ['Close']);
    assert.strictEqual(active.querySelector('input'), null);

    const openedButStalePlaced = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-opened-stale',
        state: 'placed',
        timestamps: { openedAt: 20 },
        card: {
          type: 'regular',
          actions: [],
          data: { ticker: 'MSFT', state: 'placed', price: 100 }
        }
      },
      key: 'position|pos-reg-opened-stale',
      title: 'MSFT'
    });
    assert.strictEqual(openedButStalePlaced.querySelector('.card__status').classList.contains('card__status--active'), true);

    const cancelled = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-3',
        state: 'cancelled',
        card: {
          type: 'regular',
          actions: [{ id: 'cancel', label: 'Cancel', command: 'position.remove', style: 'cancel' }],
          data: { ticker: 'MSFT', event: 'up', price: 100, qty: 2, sl: 1, riskUsd: 10 }
        }
      },
      key: 'position|pos-reg-3',
      title: 'MSFT'
    });
    assert.strictEqual(cancelled.classList.contains('card--mini'), false);
    assert.strictEqual(cancelled.querySelector('.card__status').style.display, 'none');
    assert.deepStrictEqual(Array.from(cancelled.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['BL']);
  }

  {
    const calls = [];
    const states = [];
    const toasts = [];
    const shakes = [];
    const pendingMarks = [];
    const pendingClears = [];
    let renderCount = 0;
    const rejectedRenderer = createRenderer({
      ipcRenderer: {
        invoke: async (ch, payload) => {
          calls.push({ ch, payload });
          return {
            ok: false,
            status: 'rejected',
            errors: [{ message: 'Qty step mismatch' }]
          };
        }
      },
      orderStateApi: {
        markPendingRequest: (requestId, key, options) => pendingMarks.push({ requestId, key, options }),
        clearPendingRequest: requestId => pendingClears.push(requestId),
        setPendingExecLabel: () => true,
        setPendingId: () => true
      },
      setCardState: (key, state) => states.push({ key, state }),
      toast: message => toasts.push(message),
      shakeCard: key => shakes.push(key),
      render: () => { renderCount += 1; },
      now: () => 20,
      random: () => 0.25
    });

    await rejectedRenderer.place('BL', {
      __positionKey: 'position|pos-rejected',
      positionId: 'pos-rejected',
      ticker: 'AAPL',
      event: 'up'
    }, {
      valid: true,
      type: 'equities',
      qtyInt: 2,
      pr: 100,
      sl: 1,
      tp: 3,
      risk: 10
    }, 'EQ', 'BL');

    assert.deepStrictEqual(calls.map(call => call.ch), ['execution:preview-place-order']);
    assert.strictEqual(pendingMarks.length, 1);
    assert.strictEqual(pendingMarks[0].key, 'position|pos-rejected');
    assert.deepStrictEqual(pendingMarks[0].options, { retryCount: 0 });
    assert.deepStrictEqual(pendingClears, [pendingMarks[0].requestId]);
    assert.deepStrictEqual(states.at(-1), { key: 'position|pos-rejected', state: null });
    assert.deepStrictEqual(toasts, ['✖ AAPL: Qty step mismatch']);
    assert.deepStrictEqual(shakes, ['position|pos-rejected']);
    assert.strictEqual(renderCount, 1);
  }

  {
    const calls = [];
    const pendingRenderer = createRenderer({
      pendingActionInfo: kind => kind === 'PBL'
        ? { side: 'long', strategy: 'consolidation' }
        : null,
      ipcRenderer: {
        invoke: async (ch, payload) => {
          calls.push({ ch, payload });
          return { status: 'ok', providerOrderId: 'pending:pending-1' };
        }
      }
    });

    await pendingRenderer.place('PBL', {
      __positionKey: 'position|pos-pending',
      positionId: 'pos-pending',
      ticker: 'NVDA',
      provider: 'simulated',
      event: 'up'
    }, {
      valid: true,
      type: 'equities',
      qtyInt: 1,
      pr: 120,
      sl: 2,
      tp: 6,
      risk: 10
    }, 'EQ', 'Pending BL');

    assert.deepStrictEqual(calls.map(call => call.ch), ['queue-place-pending']);
    assert.strictEqual(calls[0].payload.meta.positionId, 'pos-pending');
  }

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  [
    'createOptionStratRenderer',
    'optionStratRenderer',
    'optionstrat/renderer',
    'emitOptionStratButtonEvent',
    'ensureOptionPayoff',
    "instrumentType === 'OPT'",
    "instrumentType !== 'OPT'",
    'registerOrderCardsRuntime',
    'let orderCardsRuntime'
  ].forEach(pattern => {
    assert.strictEqual(rendererSource.includes(pattern), false, `app/renderer.js still contains ${pattern}`);
  });

  console.log('orderCardsRenderer tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
