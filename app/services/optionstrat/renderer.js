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
  placedOrderByKey,
  cardStates,
  pendingOptionValuations = new Set(),
  setCardState,
  ticketToKey,
  getValuationRefreshMs = () => 5000,
  setTimeoutFn = setTimeout,
  now = () => Date.now()
} = {}) {
  const pendingOptionPayoffs = new Set();
  let displayFields = { ...DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS };
  let valuationRefreshMs = Number(getValuationRefreshMs()) || 5000;

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
    const orderInfo = placedOrderByKey.get(key);
    if (orderInfo && !orderInfo.openedAt) orderInfo.openedAt = timestamp;
  }

  function markRowClosed(key, timestamp = now()) {
    const row = state.rows.find(r => rowKey(r) === key);
    if (row && row.instrumentType === 'OPT') {
      if (!row.openedAt) row.openedAt = timestamp;
      row.closedAt = timestamp;
    }
    const orderInfo = placedOrderByKey.get(key);
    if (orderInfo) {
      if (!orderInfo.openedAt) orderInfo.openedAt = timestamp;
      orderInfo.closedAt = timestamp;
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
      const stored = placedOrderByKey.get(key);
      if (stored) stored.valuation = result.valuation;
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
        const entries = Array.from(placedOrderByKey.entries())
          .filter(([key]) => {
            if (cardStates.get(key) !== 'placed') return false;
            const row = state.rows.find(r => rowKey(r) === key);
            return row?.instrumentType === 'OPT';
          });
        await Promise.all(entries.map(([key, orderInfo]) => refreshOptionValuation(key, orderInfo)));
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
      if (!current || cardStates.get(key)) return;
      place('OPEN', current, { valid: true, type: 'option' }, 'OPT', 'OPEN');
    }, 0);
    return true;
  }

  return {
    DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS,
    pendingOptionPayoffs,
    pendingOptionValuations,
    normalizeOptionStratDisplayFields,
    setDisplayFields,
    setValuationRefreshMs,
    createOptionBody,
    ensureOptionPayoff,
    refreshOptionValuation,
    startValuationRefresh,
    scheduleInstantExecution,
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
