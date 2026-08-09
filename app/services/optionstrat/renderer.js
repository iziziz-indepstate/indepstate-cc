const { buildOptionStratHedgePayload } = require('./hedge');

const DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS = {
  pl: true,
  value: true,
  maxLoss: true,
  maxProfit: true,
  change: true,
  rr: true
};

function normalizeOptionStratDisplayFields(fields = {}) {
  const normalized = { ...DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return normalized;
  for (const key of Object.keys(normalized)) {
    if (typeof fields[key] === 'boolean') normalized[key] = fields[key];
  }
  return normalized;
}

function createOptionStratRenderer({
  ipcRenderer,
  el,
  state,
  rowKey,
  render,
  toast,
  shakeCard,
  legacyOrderStateApi,
  pendingOptionValuations = new Set(),
  setCardState,
  getValuationRefreshMs = () => 5000,
  setTimeoutFn = setTimeout,
  now = () => Date.now()
} = {}) {
  const pendingOptionPayoffs = new Set();
  let displayFields = { ...DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS };
  let valuationRefreshMs = Number(getValuationRefreshMs()) || 5000;
  const legacyState = legacyOrderStateApi || {
    getCardState: () => undefined,
    clearPendingRequest: () => false,
    markPlacedOrder: () => false,
    getPlacedOrder: () => undefined,
    bindTicket: () => false,
    listPlacedOrders: () => []
  };

  function setDisplayFields(fields) {
    displayFields = normalizeOptionStratDisplayFields(fields);
    return displayFields;
  }

  function setValuationRefreshMs(ms) {
    const value = Number(ms);
    if (Number.isFinite(value) && value > 0) valuationRefreshMs = value;
    return valuationRefreshMs;
  }

  function signedOptionLegQty(leg) {
    const qty = Math.abs(Number(leg?.quantity ?? leg?.qty ?? 0));
    const side = String(leg?.side || '').toLowerCase();
    return side === 'sell' || side === 'short' ? -qty : qty;
  }

  function formatCurrencyValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    const sign = n < 0 ? '-' : '';
    return `${sign}$${Math.abs(n).toFixed(0)}`;
  }

  function formatPayoffValue(value, infinite) {
    return infinite ? '∞' : formatCurrencyValue(value);
  }

  function optionPayoffForRow(row) {
    return row?.payoff || row?.estimatedPayoff || row?.meta?.payoff || null;
  }

  function optionValuationForRow(row) {
    return row?.valuation || row?.optionValuation || row?.meta?.valuation || null;
  }

  function formatPercentValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    return `${sign}${Math.abs(n).toFixed(1)}%`;
  }

  function optionLegToken(leg) {
    const qty = signedOptionLegQty(leg);
    const absQty = Math.abs(qty);
    const optionCode = String(leg.option || '').toUpperCase().startsWith('P') ? 'P' : 'C';
    return `${qty > 0 ? '+' : '-'}${absQty}${optionCode}${leg.strike}`;
  }

  function formatRiskReward(payoff) {
    if (!payoff) return '-';
    if (payoff.isMaxLossInfinite) return '-';
    const loss = Number(payoff.maxLoss);
    if (!Number.isFinite(loss) || loss < 0) return '-';
    if (payoff.isMaxProfitInfinite) return '1:∞';
    const profit = Number(payoff.maxProfit);
    if (!Number.isFinite(profit)) return '-';
    if (loss === 0) return profit > 0 ? '1:∞' : '-';
    return `1:${(profit / loss).toFixed(1)}`;
  }

  function coerceTimeValue(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      return value < 10000000000 ? value * 1000 : value;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10000000000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatTradeTime(value) {
    const ms = coerceTimeValue(value);
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function markRowOpened(key, timestamp = now()) {
    const row = state.rows.find(r => rowKey(r) === key);
    if (row && row.instrumentType === 'OPT' && !row.openedAt) row.openedAt = timestamp;
    const orderInfo = legacyState.getPlacedOrder(key);
    if (orderInfo && !orderInfo.openedAt) orderInfo.openedAt = timestamp;
    if (orderInfo) legacyState.markPlacedOrder(key, orderInfo);
  }

  function markRowClosed(key, timestamp = now()) {
    const row = state.rows.find(r => rowKey(r) === key);
    if (row && row.instrumentType === 'OPT') {
      if (!row.openedAt) row.openedAt = timestamp;
      row.closedAt = timestamp;
    }
    const orderInfo = legacyState.getPlacedOrder(key);
    if (orderInfo) {
      if (!orderInfo.openedAt) orderInfo.openedAt = timestamp;
      orderInfo.closedAt = timestamp;
      legacyState.markPlacedOrder(key, orderInfo);
    }
  }

  function emitButtonEvent(action, row) {
    if (!row || row.instrumentType !== 'OPT') return;
    const { payload } = buildOptionStratHedgePayload(action, row);
    if (!payload.hedgeOpenSide) return;
    ipcRenderer.invoke('optionstrat:button-event', { action, row }).catch((err) => {
      console.warn('[optionstrat hedge]', err?.message || err);
    });
  }

  function createOptionBody(row) {
    const line = el('div', 'quad-line option-legs');
    line.style.display = 'grid';
    line.style.gridTemplateColumns = '1fr';
    line.style.gap = '4px';

    const legs = Array.isArray(row.legs) ? row.legs : [];
    const summary = el('div', 'option-summary', null, {
      style: 'font-size:12px;color:#e5e7eb;display:flex;align-items:center;gap:3px;flex-wrap:wrap'
    });
    summary.appendChild(document.createTextNode(`${row.ticker || row.symbol || ''} ${row.expirationDte || ''} `.trim()));
    if (legs.length) summary.appendChild(document.createTextNode(' '));
    legs.forEach((leg, idx) => {
      const qty = signedOptionLegQty(leg);
      const legNode = el('span', null, optionLegToken(leg), {
        style: `color:${qty < 0 ? '#ef4444' : '#22c55e'};font-weight:700`
      });
      summary.appendChild(legNode);
      if (idx < legs.length - 1) summary.appendChild(document.createTextNode('/'));
    });
    line.appendChild(summary);

    const detailsRow = el('div', 'option-details', null, {
      style: 'display:flex;align-items:center;gap:8px;font-size:11px;line-height:1.2;flex-wrap:wrap'
    });
    const payoff = optionPayoffForRow(row);
    const valuation = optionValuationForRow(row);
    const openedAt = row.openedAt || row.meta?.openedAt;
    const closedAt = row.closedAt || row.meta?.closedAt;

    const maxLoss = payoff ? formatPayoffValue(payoff.maxLoss, payoff.isMaxLossInfinite) : '-';
    const maxProfit = payoff ? formatPayoffValue(payoff.maxProfit, payoff.isMaxProfitInfinite) : '-';
    const rr = formatRiskReward(payoff);
    const change = valuation ? Number(valuation.change) : NaN;
    const color = change > 0 ? '#22c55e' : change < 0 ? '#ef4444' : '#e5e7eb';

    if (valuation && displayFields.pl) {
      const changeNode = el('span', null, 'P/L ', { style: 'color:#fff' });
      changeNode.appendChild(el('span', null, formatCurrencyValue(change), { style: `color:${color};font-weight:700` }));
      detailsRow.appendChild(changeNode);
    }
    if (valuation && displayFields.value) {
      const valueNode = el('span', null, 'Value ', { style: 'color:#fff' });
      valueNode.appendChild(el('span', null, formatCurrencyValue(valuation.currentValue), { style: 'color:#e5e7eb;font-weight:700' }));
      detailsRow.appendChild(valueNode);
    }
    if (displayFields.maxLoss) {
      const lossNode = el('span', null, 'Max Loss ', { style: 'color:#fff' });
      lossNode.appendChild(el('span', null, maxLoss, { style: 'color:#ef4444;font-weight:700' }));
      detailsRow.appendChild(lossNode);
    }
    if (displayFields.maxProfit) {
      const profitNode = el('span', null, 'Max Profit ', { style: 'color:#fff' });
      profitNode.appendChild(el('span', null, maxProfit, { style: 'color:#22c55e;font-weight:700' }));
      detailsRow.appendChild(profitNode);
    }
    if (valuation && displayFields.change) {
      const pctNode = el('span', null, 'Change ', { style: 'color:#fff' });
      pctNode.appendChild(el('span', null, formatPercentValue(valuation.changePct), { style: `color:${color};font-weight:700` }));
      detailsRow.appendChild(pctNode);
    }
    if (displayFields.rr) {
      const rrNode = el('span', null, 'RR ', { style: 'color:#fff' });
      rrNode.appendChild(el('span', null, rr, { style: 'color:#e5e7eb;font-weight:700' }));
      detailsRow.appendChild(rrNode);
    }
    if (openedAt) {
      const openedNode = el('span', null, 'Opened ', { style: 'color:#9ca3af' });
      openedNode.appendChild(el('span', null, formatTradeTime(openedAt), { style: 'color:#e5e7eb;font-weight:700' }));
      detailsRow.appendChild(openedNode);
    }
    if (closedAt) {
      const closedNode = el('span', null, 'Closed ', { style: 'color:#9ca3af' });
      closedNode.appendChild(el('span', null, formatTradeTime(closedAt), { style: 'color:#e5e7eb;font-weight:700' }));
      detailsRow.appendChild(closedNode);
    }
    if (detailsRow.childNodes.length) line.appendChild(detailsRow);

    return {
      type: 'option',
      line,
      setButtons($btns) {
        this._btns = $btns;
      },
      setNote($note) {
        this._note = $note;
      },
      validate() {
        const valid = !!(row.ticker || row.symbol) && legs.length > 0;
        line.classList.toggle('card--invalid', !valid);
        const reason = valid ? '' : 'Option legs required';
        if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
          b.disabled = !valid;
          if (!valid) b.title = reason; else b.removeAttribute('title');
        });
        if (this._note) {
          this._note.textContent = reason;
          this._note.style.display = reason ? 'block' : 'none';
        }
        return { valid, type: 'option' };
      }
    };
  }

  function firstText(...values) {
    for (const value of values) {
      if (value == null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  function firstValue(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function optionSnapshotRow(position = {}) {
    const source = position.source || {};
    const intent = position.executionIntent || {};
    const card = position.card || {};
    const data = card.data || {};
    const base = {
      ...source,
      ...intent,
      ...data,
      ...position
    };
    const ticker = firstText(data.ticker, source.ticker, intent.ticker, position.ticker, data.symbol, source.symbol, intent.symbol, position.symbol);
    const symbol = firstText(data.symbol, source.symbol, intent.symbol, position.symbol, ticker);
    const provider = firstText(data.provider, source.provider, intent.provider, position.provider, 'optionstrat');
    return {
      ...base,
      ticker,
      symbol,
      provider,
      instrumentType: 'OPT',
      event: firstText(data.event, source.event, intent.event, position.event, 'optionstrat'),
      name: firstText(data.name, source.name, intent.name, position.name, ticker),
      strategyCommand: firstText(data.strategyCommand, source.strategyCommand, intent.strategyCommand, position.strategyCommand),
      legs: firstValue(data.legs, source.legs, intent.legs, position.legs, []),
      payoff: firstValue(data.payoff, position.payoff, source.payoff, intent.payoff, data.estimatedPayoff, source.estimatedPayoff),
      valuation: firstValue(data.valuation, position.valuation, source.valuation, intent.valuation, data.optionValuation, source.optionValuation),
      openedAt: firstValue(data.openedAt, source.openedAt, intent.openedAt, position.openedAt, position.timestamps?.openedAt, position.timestamps?.placedAt),
      closedAt: firstValue(data.closedAt, source.closedAt, intent.closedAt, position.closedAt, position.timestamps?.closedAt),
      ticket: firstText(data.ticket, source.ticket, intent.ticket, position.ticket, position.primaryTicket, data.providerOrderId, source.providerOrderId, optionSnapshotTickets(position)[0])
    };
  }

  function optionSnapshotTickets(position = {}) {
    const data = position.card?.data || {};
    const source = position.source || {};
    const intent = position.executionIntent || {};
    const tickets = [
      position.ticket,
      position.primaryTicket,
      data.ticket,
      source.ticket,
      intent.ticket,
      position.providerOrderId,
      data.providerOrderId,
      source.providerOrderId,
      intent.providerOrderId,
      ...(Array.isArray(position.tickets) ? position.tickets : []),
      ...(Array.isArray(data.tickets) ? data.tickets : []),
      ...(Array.isArray(source.tickets) ? source.tickets : []),
      ...(Array.isArray(intent.tickets) ? intent.tickets : [])
    ];
    const childTickets = []
      .concat(Array.isArray(position.children) ? position.children : [])
      .concat(Array.isArray(data.children) ? data.children : [])
      .concat(Array.isArray(source.children) ? source.children : []);
    for (const child of childTickets) {
      tickets.push(child?.ticket, child?.providerOrderId, child?.result?.ticket, child?.result?.providerOrderId);
    }
    const seen = new Set();
    return tickets.map(value => firstText(value)).filter(ticket => {
      if (!ticket || seen.has(ticket)) return false;
      seen.add(ticket);
      return true;
    });
  }

  function ticketForOptionSnapshot(position = {}, action = {}) {
    const data = position.card?.data || {};
    const source = position.source || {};
    const intent = position.executionIntent || {};
    const actionPayload = action.payload || {};
    return firstText(
      actionPayload.ticket,
      action.ticket,
      actionPayload.providerOrderId,
      data.ticket,
      source.ticket,
      intent.ticket,
      position.ticket,
      position.primaryTicket,
      data.providerOrderId,
      source.providerOrderId,
      intent.providerOrderId,
      optionSnapshotTickets(position)[0]
    );
  }

  function canRenderOptionSnapshotAction(position = {}, action = {}) {
    if (action.command !== 'position.close') return true;
    return !!ticketForOptionSnapshot(position, action);
  }

  function closeOptionSnapshot(position = {}, action = {}) {
    const row = optionSnapshotRow(position);
    const ticket = ticketForOptionSnapshot(position, action);
    const provider = firstText(action.payload?.provider, row.provider, position.provider, 'optionstrat');
    if (!ticket || !provider) {
      return Promise.resolve({ status: 'unsupported', reason: 'ticket required' });
    }
    emitButtonEvent('close', row);
    return ipcRenderer.invoke('execution:cancel-order', {
      ...(action.payload || {}),
      provider,
      ticket,
      symbol: firstText(action.payload?.symbol, row.symbol, row.ticker),
      name: firstText(action.payload?.name, row.name, row.ticker)
    });
  }

  function createOptionPositionCard({
    position = {},
    key,
    createActionButton,
    createActionsFromSnapshot,
    requestRemove
  } = {}) {
    const row = optionSnapshotRow(position);
    const cardKey = key || `position|${position.id || row.ticket || row.ticker}`;
    const cardType = position.card?.type || 'option';
    const card = el('div', 'card position-card');
    card.setAttribute('data-rowkey', cardKey);
    card.setAttribute('data-position-id', position.id || '');
    card.setAttribute('data-card-type', cardType);
    card.setAttribute('data-ticker', row.ticker || row.symbol || '');
    card.setAttribute('data-instrument-type', 'OPT');

    const head = el('div', 'row');
    const left = el('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
    left.appendChild(el('div', null, row.name || row.ticker || row.symbol || position.id || 'Position', { style: 'font-weight:600;font-size:13px' }));
    head.appendChild(left);

    const right = el('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
    const stateName = position.state || row.state || 'draft';
    const status = el('span', `card__status card__status--${stateName}`);
    status.style.display = 'inline-block';
    status.title = stateName;
    right.appendChild(status);

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = String.fromCharCode(215);
    close.className = 'card__close';
    Object.assign(close.style, {
      border: 'none',
      background: 'transparent',
      width: '22px',
      height: '22px',
      lineHeight: '22px',
      textAlign: 'center',
      fontSize: '16px',
      cursor: 'pointer',
      borderRadius: '4px',
      color: '#c62828',
      marginLeft: '8px'
    });
    close.title = 'Remove card';
    close.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (typeof requestRemove !== 'function') return;
      close.disabled = true;
      await requestRemove(position).catch(() => {
        close.disabled = false;
      });
    });
    right.appendChild(close);
    head.appendChild(right);

    const body = createOptionBody(row);
    const btns = el('div', 'btns position-card__actions');
    const actions = (Array.isArray(position.card?.actions) ? position.card.actions : [])
      .filter(action => canRenderOptionSnapshotAction(position, action));
    btns.style.gridTemplateColumns = `repeat(${Math.max(1, actions.length)},1fr)`;
    for (const action of actions) {
      const label = action.label || action.id;
      const kind = action.id || label;
      const onClick = async () => {
        const validated = body.validate();
        if (!validated.valid) return { status: 'rejected', reason: 'Invalid option snapshot' };
        if (action.command === 'position.close') {
          const result = await closeOptionSnapshot(position, action);
          if (!result || result.status === 'error' || result.status === 'rejected' || result.status === 'unsupported') {
            toast?.(`x ${row.name || row.ticker || row.symbol}: ${result?.reason || 'Close failed'}`);
            shakeCard?.(cardKey);
          }
          return result;
        }
        if (action.command === 'position.remove' && typeof requestRemove === 'function') {
          const result = await requestRemove(position);
          return result?.ok === false ? { status: 'error', reason: result.reason } : { status: 'ok' };
        }
        if (typeof createActionsFromSnapshot === 'function') {
          return createActionsFromSnapshot(position, action, validated);
        }
        return { status: 'unsupported', reason: `Unsupported position action ${action.command || kind}` };
      };
      const button = typeof createActionButton === 'function'
        ? createActionButton({ label, kind, className: (action.style || kind || 'action').toLowerCase(), onClick })
        : null;
      if (button) btns.appendChild(button);
    }

    card.appendChild(head);
    card.appendChild(el('div', 'meta'));
    card.appendChild(body.line);
    card.appendChild(btns);
    const note = el('div', 'card__note');
    card.appendChild(note);
    body.setButtons(btns);
    if (body.setNote) body.setNote(note);
    body.validate();
    card._validate = () => body.validate();
    return card;
  }

  function ensureOptionPayoff(row) {
    if (!row || row.instrumentType !== 'OPT') return;
    if (optionPayoffForRow(row)) return;
    const key = rowKey(row);
    if (pendingOptionPayoffs.has(key)) return;
    pendingOptionPayoffs.add(key);
    ipcRenderer.invoke('optionstrat:estimate', {
      instrumentType: 'OPT',
      provider: row.provider || 'optionstrat',
      ticker: row.ticker || row.symbol,
      symbol: row.symbol || row.ticker,
      root: row.root,
      name: row.name,
      description: row.description,
      expirationDte: row.expirationDte || row.expiration,
      isCustomName: row.isCustomName,
      isCashSecured: row.isCashSecured,
      legs: row.legs
    }).then(result => {
      if (result?.status !== 'ok' || !result.payoff) return;
      const current = state.rows.find(r => rowKey(r) === key);
      if (!current) return;
      current.estimatedPayoff = result.estimatedPayoff || result.payoff;
      render();
    }).catch(() => {
    }).finally(() => {
      pendingOptionPayoffs.delete(key);
    });
  }

  function refreshOptionValuation(key, orderInfo) {
    if (!orderInfo || !orderInfo.ticket || !orderInfo.provider) return Promise.resolve(null);
    if (pendingOptionValuations.has(key)) return Promise.resolve(null);
    pendingOptionValuations.add(key);
    return ipcRenderer.invoke('optionstrat:valuation', {
      provider: orderInfo.provider,
      ticket: orderInfo.ticket,
      symbol: orderInfo.symbol
    }).then(result => {
      if (result?.status !== 'ok' || !result.valuation) return result;
      const current = state.rows.find(r => rowKey(r) === key);
      if (current) {
        current.valuation = result.valuation;
        render();
      }
      const stored = legacyState.getPlacedOrder(key);
      if (stored) {
        stored.valuation = result.valuation;
        legacyState.markPlacedOrder(key, stored);
      }
      return result;
    }).catch(err => {
      return { status: 'error', reason: err?.message || String(err) };
    }).finally(() => {
      pendingOptionValuations.delete(key);
    });
  }

  function startValuationRefresh() {
    setTimeoutFn(async function tick() {
      try {
        const entries = legacyState.listPlacedOrders({ state: 'placed', instrumentType: 'OPT' });
        await Promise.all(entries.map(({ key, orderInfo }) => refreshOptionValuation(key, orderInfo)));
      } finally {
        setTimeoutFn(tick, Math.max(1000, Number(valuationRefreshMs) || 5000));
      }
    }, Math.max(1000, Number(valuationRefreshMs) || 5000));
  }

  function scheduleInstantExecution(row, place) {
    if (!row || row.instrumentType !== 'OPT' || row.instantExecution !== true) return false;
    setTimeoutFn(() => {
      const key = rowKey(row);
      const current = state.rows.find(r => rowKey(r) === key);
      if (!current || legacyState.getCardState(key)) return;
      place('OPEN', current, { valid: true, type: 'option' }, 'OPT', 'OPEN');
    }, 0);
    return true;
  }

  function preparePlace({ row, requestId, baseMeta } = {}) {
    const meta = {
      ...(baseMeta || {}),
      requestId,
      qty: 1,
      stopPts: 1,
      takePts: null
    };
    emitButtonEvent('open', row);
    return {
      channel: 'queue-place-order',
      payload: {
        ticker: row.ticker,
        symbol: row.symbol || row.ticker,
        root: row.root,
        provider: row.provider,
        instrumentType: 'OPT',
        event: row.event,
        time: row.time,
        cardType: row.cardType || 'option',
        name: row.name,
        description: row.description,
        expirationDte: row.expirationDte,
        isCustomName: row.isCustomName,
        isCashSecured: row.isCashSecured,
        legs: row.legs,
        side: 'OPEN',
        meta
      }
    };
  }

  function afterPlaceOk({ row, result, requestId, key } = {}) {
    if (!result?.providerOrderId) {
      setCardState(key, 'pending');
      return;
    }
    const openedAt = now();
    legacyState.clearPendingRequest(requestId);
    legacyState.markPlacedOrder(key, {
      provider: result.provider || row.provider || 'optionstrat',
      ticket: String(result.providerOrderId),
      symbol: row.symbol || row.ticker || '',
      strategyCommand: row.strategyCommand,
      name: row.name,
      payoff: result.payoff || result.raw?.payoff,
      valuation: result.valuation || result.raw?.valuation,
      openedAt
    });
    if (result.payoff || result.raw?.payoff) row.payoff = result.payoff || result.raw.payoff;
    if (result.valuation || result.raw?.valuation) row.valuation = result.valuation || result.raw.valuation;
    row.openedAt = row.openedAt || openedAt;
    legacyState.bindTicket(String(result.providerOrderId), key);
    setCardState(key, 'placed');
  }

  function createOrderCardHandler() {
    return {
      createBody: createOptionBody,
      buttons: () => [{ label: 'OPEN', action: 'OPEN', style: 'bl' }],
      preparePlace,
      afterPlaceOk,
      scheduleInstantExecution: ({ row, place } = {}) => scheduleInstantExecution(row, place)
    };
  }

  return {
    DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS,
    pendingOptionPayoffs,
    pendingOptionValuations,
    normalizeOptionStratDisplayFields,
    setDisplayFields,
    setValuationRefreshMs,
    createOptionBody,
    optionSnapshotRow,
    createOptionPositionCard,
    closeOptionSnapshot,
    ensureOptionPayoff,
    refreshOptionValuation,
    startValuationRefresh,
    scheduleInstantExecution,
    preparePlace,
    afterPlaceOk,
    createOrderCardHandler,
    markRowOpened,
    markRowClosed,
    emitButtonEvent,
    optionPayoffForRow,
    optionValuationForRow
  };
}

module.exports = {
  DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS,
  normalizeOptionStratDisplayFields,
  createOptionStratRenderer
};
