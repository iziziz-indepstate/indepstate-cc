const { shouldRouteRowToLegacyRuntime } = require('./legacyRouting');

function createLegacyOrderListRuntime({
  ipcRenderer,
  state: providedState,
  legacyState: providedLegacyState = {},
  rowKey,
  findKeyByTicker,
  matchesExistingOrderRow,
  isTerminalCardState,
  cardByKey,
  setCardState,
  orderCardHandlerForRow,
  orderCardHandlerForKey,
  scheduleOrderCardInstantExecution,
  removePositionSnapshotsForLegacyRow,
  positionMatchesLegacyRow,
  isRegularPositionSnapshot,
  shouldFilterLegacyRow = () => false,
  shouldIgnoreLegacyRowForExistingPosition = () => false,
  shouldIgnoreLegacyExecutionEvent = () => false,
  shouldIgnoreLegacyPositionEvent = () => false,
  shouldRemoveLegacyRowForPosition = () => false,
  shouldResetLegacyRowForPosition = () => false,
  forgetInstrument = () => {},
  toast = () => {},
  shakeCard = () => {},
  render = () => {},
  now = () => Date.now(),
  maxRows = 500
} = {}) {
  const state = providedState || { rows: [], filter: '', autoscroll: true };
  const orderCardsEventIds = providedLegacyState.orderCardsEventIds || new Set();
  const orderCardsEventIdOrder = providedLegacyState.orderCardsEventIdOrder || [];
  const maxRememberedOrderCardsEventIds = 150;

  const cardStates = providedLegacyState.cardStates || new Map();
  const pendingExecLabels = providedLegacyState.pendingExecLabels || new Map();
  const pendingByReqId = providedLegacyState.pendingByReqId || new Map();
  const pendingIdByReqId = providedLegacyState.pendingIdByReqId || new Map();
  const ticketToKey = providedLegacyState.ticketToKey || new Map();
  const placedOrderByKey = providedLegacyState.placedOrderByKey || new Map();
  const retryCounts = providedLegacyState.retryCounts || new Map();
  const instantExecutedKeys = providedLegacyState.instantExecutedKeys || new Set();
  const uiState = providedLegacyState.uiState || new Map();
  const userTouchedByTicker = providedLegacyState.userTouchedByTicker || new Map();

  let closedCardEventStrategy = 'ignore';
  const closedCardStrategies = {
    ignore: () => {},
    revive: ({ row, idx, oldRow, oldKey }) => {
      userTouchedByTicker.delete(row.ticker);
      setCardState(oldKey, null);
      const newRow = { ...oldRow, ...row };
      const newKey = rowKey(newRow);
      state.rows[idx] = newRow;
      migrateKey(oldKey, newKey, {
        preserveUi: false,
        nextUiPatch: () => uiPatchFromRow(row)
      });
      const updated = state.rows.splice(idx, 1)[0];
      state.rows.unshift(updated);
      trimRows();
      render();
    }
  };
  let handleClosedCard = closedCardStrategies.ignore;

  function extractOrderCardsEventId(payload) {
    const eventId = payload?.eventId || payload?.__orderCardsEventId;
    return eventId == null ? '' : String(eventId);
  }

  function rememberOrderCardsEventId(eventId) {
    if (!eventId) return false;
    if (orderCardsEventIds.has(eventId)) return true;
    orderCardsEventIds.add(eventId);
    orderCardsEventIdOrder.push(eventId);
    while (orderCardsEventIdOrder.length > maxRememberedOrderCardsEventIds) {
      const expired = orderCardsEventIdOrder.shift();
      if (expired) orderCardsEventIds.delete(expired);
    }
    return false;
  }

  function withoutOrderCardsEventId(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (!Object.prototype.hasOwnProperty.call(payload, '__orderCardsEventId')) return payload;
    const { __orderCardsEventId, ...rest } = payload;
    return rest;
  }

  function setClosedCardEventStrategy(strategy) {
    closedCardEventStrategy = strategy || 'ignore';
    handleClosedCard = closedCardStrategies[closedCardEventStrategy] || closedCardStrategies.ignore;
  }

  function uiPatchFromRow(row = {}) {
    const patch = {};
    if (row.qty != null) patch.qty = String(row.qty);
    if (row.price != null) patch.price = String(row.price);
    if (row.sl != null) patch.sl = String(row.sl);
    if (row.tp != null) patch.tp = String(row.tp);
    return patch;
  }

  function trimRows() {
    if (state.rows.length > maxRows) state.rows.length = maxRows;
  }

  function rows() {
    return state.rows;
  }

  function setFilter(filter) {
    state.filter = filter || '';
  }

  function setAutoscroll(value) {
    state.autoscroll = !!value;
  }

  function markTouched(ticker) {
    if (ticker) userTouchedByTicker.set(ticker, true);
  }

  function isTouched(ticker) {
    return !!userTouchedByTicker.get(ticker);
  }

  function migrateKey(oldKey, newKey, { preserveUi = false, nextUiPatch = null } = {}) {
    if (oldKey === newKey) return;

    if (uiState.has(oldKey)) {
      const prev = uiState.get(oldKey);
      const next = preserveUi ? prev : { ...(prev || {}) };
      if (typeof nextUiPatch === 'function') Object.assign(next, nextUiPatch(prev));
      uiState.set(newKey, next);
      uiState.delete(oldKey);
    }

    for (const [rid, key] of pendingByReqId.entries()) {
      if (key === oldKey) pendingByReqId.set(rid, newKey);
    }

    if (cardStates.has(oldKey)) {
      cardStates.set(newKey, cardStates.get(oldKey));
      cardStates.delete(oldKey);
    }

    if (pendingExecLabels.has(oldKey)) {
      pendingExecLabels.set(newKey, pendingExecLabels.get(oldKey));
      pendingExecLabels.delete(oldKey);
    }

    if (placedOrderByKey.has(oldKey)) {
      placedOrderByKey.set(newKey, placedOrderByKey.get(oldKey));
      placedOrderByKey.delete(oldKey);
    }

    for (const [ticket, key] of ticketToKey.entries()) {
      if (key === oldKey) ticketToKey.set(ticket, newKey);
    }
  }

  function legacyRowsForRender(cardStateOrder = {}) {
    const f = (state.filter || '').trim().toLowerCase();
    const list = f
      ? state.rows.filter(r => (r.ticker || '').toLowerCase().startsWith(f))
      : state.rows.slice();

    list.sort((a, b) => {
      const stateA = cardStates.get(rowKey(a));
      const stateB = cardStates.get(rowKey(b));
      const orderA = stateA ? (cardStateOrder[stateA] ?? 6) : 0;
      const orderB = stateB ? (cardStateOrder[stateB] ?? 6) : 0;
      if (orderA !== orderB) return orderA - orderB;
      return 0;
    });
    return list;
  }

  function renderLegacyCards(parentRenderFn, cardStateOrder = {}) {
    const rows = legacyRowsForRender(cardStateOrder);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const key = rowKey(row);
      const card = parentRenderFn(row, i);
      for (const [rid, k] of pendingByReqId.entries()) {
        if (k === key) card.dataset.reqId = rid;
      }
      const st = cardStates.get(key);
      if (st) setCardState(key, st);
    }
  }

  function clearPendingByKey(key) {
    for (const [rid, pendingKey] of pendingByReqId.entries()) {
      if (pendingKey === key) {
        pendingByReqId.delete(rid);
        pendingIdByReqId.delete(rid);
        retryCounts.delete(rid);
      }
    }
  }

  function snapshot(value) {
    if (!value || typeof value !== 'object') return value;
    return { ...value };
  }

  function markPendingRequest(reqId, key, options = {}) {
    if (!reqId || !key) return false;
    pendingByReqId.set(String(reqId), key);
    retryCounts.set(String(reqId), Number.isFinite(Number(options.retryCount)) ? Number(options.retryCount) : 0);
    if (options.pendingId) pendingIdByReqId.set(String(reqId), options.pendingId);
    return true;
  }

  function clearPendingRequest(reqId) {
    if (!reqId) return false;
    const id = String(reqId);
    const had = pendingByReqId.has(id) || pendingIdByReqId.has(id) || retryCounts.has(id);
    pendingByReqId.delete(id);
    pendingIdByReqId.delete(id);
    retryCounts.delete(id);
    return had;
  }

  function clearLegacyExecutionState(_row, key) {
    cardStates.delete(key);
    pendingExecLabels.delete(key);
    placedOrderByKey.delete(key);
    clearPendingByKey(key);
    for (const [ticket, ticketKey] of ticketToKey.entries()) {
      if (ticketKey === key) ticketToKey.delete(ticket);
    }
  }

  function clearExecutionStateByKey(key) {
    if (!key) return false;
    clearLegacyExecutionState(null, key);
    return true;
  }

  const legacyOrderStateApi = {
    getCardState: key => cardStates.get(key),
    setCardState: (key, stateName) => {
      if (!key) return false;
      if (stateName) cardStates.set(key, stateName);
      else cardStates.delete(key);
      return true;
    },
    clearCardState: key => {
      if (!key) return false;
      return cardStates.delete(key);
    },
    setPendingExecLabel: (key, label) => {
      if (!key) return false;
      if (label) pendingExecLabels.set(key, label);
      else pendingExecLabels.delete(key);
      return true;
    },
    getPendingExecLabel: key => pendingExecLabels.get(key),
    clearPendingExecLabel: key => {
      if (!key) return false;
      return pendingExecLabels.delete(key);
    },
    markPendingRequest,
    resolvePendingKey: reqId => (reqId ? pendingByReqId.get(String(reqId)) : undefined),
    setPendingId: (reqId, pendingId) => {
      if (!reqId) return false;
      const id = String(reqId);
      if (pendingId) pendingIdByReqId.set(id, pendingId);
      else pendingIdByReqId.delete(id);
      return true;
    },
    getPendingId: reqId => (reqId ? pendingIdByReqId.get(String(reqId)) : undefined),
    getRetryCount: reqId => (reqId ? retryCounts.get(String(reqId)) : undefined),
    findPendingRequestIdByKey: key => {
      if (!key) return undefined;
      for (const [reqId, pendingKey] of pendingByReqId.entries()) {
        if (pendingKey === key) return reqId;
      }
      return undefined;
    },
    clearPendingRequest,
    clearPendingByKey,
    markPlacedOrder: (key, orderInfo = {}) => {
      if (!key) return false;
      placedOrderByKey.set(key, snapshot(orderInfo));
      return true;
    },
    getPlacedOrder: key => snapshot(placedOrderByKey.get(key)),
    deletePlacedOrder: key => {
      if (!key) return false;
      return placedOrderByKey.delete(key);
    },
    resolveTicketKey: ticket => (ticket != null ? ticketToKey.get(String(ticket)) : undefined),
    bindTicket: (ticket, key) => {
      if (ticket == null || !key) return false;
      ticketToKey.set(String(ticket), key);
      return true;
    },
    unbindTicket: ticket => {
      if (ticket == null) return false;
      return ticketToKey.delete(String(ticket));
    },
    listPlacedOrders: (options = {}) => {
      const filter = typeof options === 'function' ? options : options.filter;
      return Array.from(placedOrderByKey.entries())
        .map(([key, orderInfo]) => ({
          key,
          orderInfo: snapshot(orderInfo),
          row: state.rows.find(r => rowKey(r) === key) || null,
          state: cardStates.get(key)
        }))
        .filter(entry => {
          if (options && typeof options === 'object') {
            if (options.state && entry.state !== options.state) return false;
            if (options.instrumentType) {
              const instrumentType = entry.row?.instrumentType || entry.orderInfo?.instrumentType;
              if (String(instrumentType || '') !== String(options.instrumentType)) return false;
            }
          }
          return typeof filter === 'function' ? !!filter(entry) : true;
        })
        .map(entry => ({
          key: entry.key,
          orderInfo: entry.orderInfo,
          state: entry.state
        }));
    },
    clearExecutionStateByKey
  };

  function cleanupRemovedRow(row, key = rowKey(row)) {
    clearLegacyExecutionState(row, key);
    uiState.delete(key);
    userTouchedByTicker.delete(row.ticker);
  }

  function removeRow(row) {
    const key = rowKey(row);
    removePositionSnapshotsForLegacyRow(row);
    const before = state.rows.length;
    state.rows = state.rows.filter(r => r !== row);
    if (state.rows.length === before) {
      state.rows = state.rows.filter(r => !(r.ticker === row.ticker && r.event === row.event && r.time === row.time && r.price === row.price));
    }
    cleanupRemovedRow(row, key);
    render();
    forgetInstrument(row.ticker, row.provider);
  }

  function removeLegacyRowsForPosition(position = {}) {
    const matches = state.rows.filter(row => {
      if (isRegularPositionSnapshot(position)) return positionMatchesLegacyRow(position, row);
      if (shouldFilterLegacyRow(row)) return positionMatchesLegacyRow(position, row);
      return shouldRemoveLegacyRowForPosition(position, row);
    });
    if (matches.length === 0) return false;
    const keys = new Set(matches.map(row => rowKey(row)));
    state.rows = state.rows.filter(row => !keys.has(rowKey(row)));
    for (const row of matches) {
      cleanupRemovedRow(row);
      forgetInstrument(row.ticker, row.provider);
    }
    return true;
  }

  function resetLegacyRowsForPosition(position = {}) {
    const matches = state.rows.filter(row => shouldResetLegacyRowForPosition(position, row));
    if (matches.length === 0) return false;
    for (const row of matches) {
      clearLegacyExecutionState(row, rowKey(row));
    }
    return true;
  }

  function removeRowByKey(key) {
    const idx = state.rows.findIndex(r => rowKey(r) === key);
    if (idx >= 0) {
      const row = state.rows[idx];
      state.rows.splice(idx, 1);
      cleanupRemovedRow(row, key);
      render();
      forgetInstrument(row.ticker, row.provider);
    }
  }

  function scheduleInstantExecution(row, place) {
    if (!row) return;
    const handler = orderCardHandlerForRow(row, row.instrumentType);
    if (!handler || typeof handler.scheduleInstantExecution !== 'function') return;
    if (typeof handler.shouldScheduleInstantExecution === 'function'
      && !handler.shouldScheduleInstantExecution({ row })) return;
    const key = rowKey(row);
    if (instantExecutedKeys.has(key)) return;
    instantExecutedKeys.add(key);
    scheduleOrderCardInstantExecution(row, place, row.instrumentType);
  }

  function loadInitialRows(limit = 100) {
    return ipcRenderer.invoke('order-cards:list', { source: 'webhooks', rows: limit }).then(rows => {
      state.rows = Array.isArray(rows)
        ? rows.filter(row => shouldRouteRowToLegacyRuntime(row) && !shouldFilterLegacyRow(row) && !shouldIgnoreLegacyRowForExistingPosition(row))
        : [];
      render();
    }).catch(() => {});
  }

  function applyOrderCardRemoval(filter) {
    if (!filter || typeof filter !== 'object') return;
    const { producingLineId } = filter;
    if (producingLineId == null) return;
    const targetId = String(producingLineId);
    if (!targetId) return;
    const matches = state.rows.filter(row => String(row.producingLineId || '') === targetId);
    if (matches.length === 0) return;
    const keysToRemove = new Set(matches.map(row => rowKey(row)));
    const nextRows = [];
    const removed = [];
    for (const row of state.rows) {
      const key = rowKey(row);
      if (keysToRemove.has(key)) {
        removed.push({ row, key });
      } else {
        nextRows.push(row);
      }
    }
    if (removed.length === 0) return;
    state.rows = nextRows;
    removed.forEach(({ row, key }) => {
      uiState.delete(key);
      cardStates.delete(key);
      clearPendingByKey(key);
      userTouchedByTicker.delete(row.ticker);
      forgetInstrument(row.ticker, row.provider);
    });
    render();
  }

  function applyOrderCardUpdate(update, { place } = {}) {
    const row = update?.row || update;
    if (!shouldRouteRowToLegacyRuntime(row)) return;
    if (shouldFilterLegacyRow(row)) return;
    if (shouldIgnoreLegacyRowForExistingPosition(row)) return;
    let idx = state.rows.findIndex(r => matchesExistingOrderRow(row, r));

    if (idx === -1) {
      state.rows.unshift(row);
      trimRows();
      render();
      scheduleInstantExecution(row, place);
      return;
    }

    const oldRow = state.rows[idx];
    const oldKey = rowKey(oldRow);
    const st = cardStates.get(oldKey);
    if (isTerminalCardState(st)) {
      handleClosedCard({ row, idx, oldRow, oldKey });
      return;
    }

    if (isTouched(row.ticker)) {
      const existing = state.rows.splice(idx, 1)[0];
      state.rows.unshift(existing);
      render();
      return;
    }

    const newRow = { ...oldRow, ...row };
    const newKey = rowKey(newRow);
    state.rows[idx] = newRow;
    migrateKey(oldKey, newKey, {
      preserveUi: false,
      nextUiPatch: () => uiPatchFromRow(row)
    });
    const updated = state.rows.splice(idx, 1)[0];
    state.rows.unshift(updated);
    trimRows();
    render();
  }

  function registerIpcHandlers({ place } = {}) {
    ipcRenderer.on('execution:pending', (_evt, rec) => {
      const reqId = rec?.reqId;
      if (!reqId) return;

      let key = pendingByReqId.get(reqId);
      if (!key) key = findKeyByTicker(rec?.order?.symbol || rec?.order?.ticker);
      if (shouldIgnoreLegacyExecutionEvent(rec)) return;
      if (!key) return;

      pendingByReqId.set(reqId, key);
      retryCounts.set(reqId, 0);
      const card = cardByKey(key);
      if (rec.pendingId) {
        pendingIdByReqId.set(reqId, rec.pendingId);
        if (card) card.dataset.pendingId = rec.pendingId;
      } else {
        pendingIdByReqId.delete(reqId);
        if (card) delete card.dataset.pendingId;
      }
      if (card) {
        card.dataset.reqId = reqId;
        const rb = card.querySelector('.retry-btn');
        if (rb) rb.textContent = '0';
      }
      if (cardStates.get(key) !== 'pending-exec' || rec?.order?.side) {
        setCardState(key, 'pending');
      }
      if (card && rec?.order) {
        const ui = uiState.get(key) || {};
        Object.assign(ui, uiPatchFromRow(rec.order));
        for (const [prop, selector] of [['qty', 'input.qty'], ['price', 'input.pr'], ['sl', 'input.sl'], ['tp', 'input.tp']]) {
          if (ui[prop] == null) continue;
          const input = card.querySelector(selector);
          if (input) input.value = ui[prop];
        }
        uiState.set(key, ui);
      }
      toast(`... ${rec.order.symbol}: queued`);
    });

    ipcRenderer.on('execution:retry', (_evt, rec) => {
      const key = pendingByReqId.get(rec.reqId);
      if (!key) return;
      retryCounts.set(rec.reqId, rec.count);
      const card = cardByKey(key);
      if (card) {
        const rb = card.querySelector('.retry-btn');
        if (rb) rb.textContent = String(rec.count);
      }
    });

    ipcRenderer.on('execution:retry-stopped', (_evt, rec) => {
      const key = pendingByReqId.get(rec.reqId);
      if (!key) return;
      pendingByReqId.delete(rec.reqId);
      retryCounts.delete(rec.reqId);
      const card = cardByKey(key);
      if (card) {
        delete card.dataset.reqId;
        const rb = card.querySelector('.retry-btn');
        if (rb) {
          rb.textContent = '0';
          rb.style.display = 'none';
        }
      }
      setCardState(key, null);
      render();
    });

    ipcRenderer.on('order-cards:changed', (_evt, update) => {
      if (update?.type === 'remove') {
        if (rememberOrderCardsEventId(extractOrderCardsEventId(update))) return;
        return applyOrderCardRemoval(update.filter);
      }
      if (update?.type === 'upsert') {
        if (rememberOrderCardsEventId(extractOrderCardsEventId(update))) return;
        return applyOrderCardUpdate(update, { place });
      }
    });

    ipcRenderer.on('execution:result', (_evt, rec) => {
      const reqId = rec?.order?.meta?.requestId || rec?.reqId;
      if (!reqId) return;
      if (shouldIgnoreLegacyExecutionEvent(rec)) return;
      const key = pendingByReqId.get(reqId);
      if (!key) return;

      pendingByReqId.delete(reqId);
      pendingIdByReqId.delete(reqId);
      retryCounts.delete(reqId);
      const card = cardByKey(key);
      if (card) {
        delete card.dataset.reqId;
        delete card.dataset.pendingId;
        const rb = card.querySelector('.retry-btn');
        if (rb) rb.textContent = '0';
      }

      const ok = rec.status === 'ok' || rec.status === 'simulated';
      if (ok) {
        const st = cardStates.get(key);
        if (st !== 'executing' && st !== 'profit' && st !== 'loss') {
          setCardState(key, 'placed');
        }
        if (rec.providerOrderId) ticketToKey.set(String(rec.providerOrderId), key);
        const providerOrderId = String(rec.providerOrderId || '');
        if (providerOrderId) {
          const row = state.rows.find(r => rowKey(r) === key);
          const symbol = rec.order?.symbol || rec.order?.ticker || row?.ticker || row?.symbol || '';
          const openedAt = now();
          placedOrderByKey.set(key, {
            provider: rec.provider || (row && row.provider) || '',
            ticket: providerOrderId,
            symbol,
            strategyCommand: row?.strategyCommand,
            name: rec.order?.name || row?.name,
            payoff: rec.payoff || rec.raw?.payoff,
            valuation: rec.valuation || rec.raw?.valuation,
            openedAt
          });
          if (row && (rec.payoff || rec.raw?.payoff)) row.payoff = rec.payoff || rec.raw.payoff;
          if (row && (rec.valuation || rec.raw?.valuation)) row.valuation = rec.valuation || rec.raw.valuation;
          if (row) orderCardHandlerForRow(row, row.instrumentType)?.onExecutionResultOk?.({ row, rec, openedAt, key });
        }
        toast(`OK ${rec.order.symbol} ${rec.order.side} ${rec.order.qty} - placed`);
        render();
      } else if (rec.status === 'unknown' || rec.partial === true) {
        setCardState(key, 'pending');
        if (card) card.title = rec.reason || 'Execution state unknown';
        toast(`... ${rec.order?.symbol || ''}: execution state unknown`);
        render();
      } else {
        setCardState(key, null);
        render();
        shakeCard(key);
        if (card) card.title = rec.reason || 'Rejected';
        toast(`x ${rec.order?.symbol || ''}: ${rec.reason || 'Rejected'}`);
      }
    });

    ipcRenderer.on('position:opened', (_evt, rec) => {
      if (shouldIgnoreLegacyPositionEvent(rec)) return;
      const ticket = String(rec.ticket);
      let key = ticketToKey.get(ticket);
      if (!key) {
        const reqId = rec.origOrder?.meta?.requestId;
        if (reqId) {
          key = pendingByReqId.get(reqId);
          if (key) ticketToKey.set(ticket, key);
        }
      }
      if (!key) return;
      placedOrderByKey.delete(key);
      const row = state.rows.find(r => rowKey(r) === key);
      orderCardHandlerForKey(key)?.onPositionOpened?.({ key, row, rec });
      setCardState(key, 'executing');
      render();
    });

    ipcRenderer.on('position:closed', (_evt, rec) => {
      if (shouldIgnoreLegacyPositionEvent(rec)) return;
      const ticket = String(rec.ticket);
      const key = ticketToKey.get(ticket);
      if (!key) return;
      const row = state.rows.find(r => rowKey(r) === key);
      orderCardHandlerForKey(key)?.onPositionClosed?.({ key, row, rec });
      if (typeof rec.profit === 'number') {
        setCardState(key, rec.profit >= 0 ? 'profit' : 'loss');
      } else {
        setCardState(key, 'closed');
      }
      render();
    });

    ipcRenderer.on('order:cancelled', (_evt, rec) => {
      if (shouldIgnoreLegacyPositionEvent(rec)) return;
      const ticket = String(rec.ticket);
      const key = ticketToKey.get(ticket);
      if (key) {
        ticketToKey.delete(ticket);
        placedOrderByKey.delete(key);
        removeRowByKey(key);
      }
    });
  }

  function mount(options = {}) {
    loadInitialRows(options.initialLimit || 100);
    registerIpcHandlers(options);
  }

  return {
    state,
    rows,
    setFilter,
    setAutoscroll,
    renderLegacyCards,
    legacyRowsForRender,
    setClosedCardEventStrategy,
    registerIpcHandlers,
    mount,
    markTouched,
    isTouched,
    migrateKey,
    removeRow,
    removeRowByKey,
    clearPendingByKey,
    clearLegacyExecutionState,
    clearExecutionStateByKey,
    removeLegacyRowsForPosition,
    resetLegacyRowsForPosition,
    applyOrderCardUpdate,
    applyOrderCardRemoval,
    scheduleInstantExecution,
    legacyOrderStateApi
  };
}

module.exports = {
  createLegacyOrderListRuntime
};
