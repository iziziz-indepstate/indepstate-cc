function createCardStateApi({ state = {}, uiState = new Map() } = {}) {
  const cardStates = new Map();
  const pendingExecLabels = new Map();
  const pendingByReqId = new Map();
  const pendingIdByReqId = new Map();
  const ticketToKey = new Map();
  const placedOrderByKey = new Map();
  const retryCounts = new Map();
  const touchedByTicker = new Map();

  function snapshot(value) {
    return value && typeof value === 'object' ? { ...value } : value;
  }

  function clearPendingByKey(key) {
    let removed = false;
    for (const [reqId, pendingKey] of pendingByReqId.entries()) {
      if (pendingKey !== key) continue;
      pendingByReqId.delete(reqId);
      pendingIdByReqId.delete(reqId);
      retryCounts.delete(reqId);
      removed = true;
    }
    return removed;
  }

  function clearExecutionStateByKey(key) {
    if (!key) return false;
    cardStates.delete(key);
    pendingExecLabels.delete(key);
    placedOrderByKey.delete(key);
    clearPendingByKey(key);
    for (const [ticket, ticketKey] of ticketToKey.entries()) {
      if (ticketKey === key) ticketToKey.delete(ticket);
    }
    return true;
  }

  function migrateKey(oldKey, newKey) {
    if (!oldKey || !newKey || oldKey === newKey) return;
    for (const map of [cardStates, pendingExecLabels, placedOrderByKey]) {
      if (!map.has(oldKey)) continue;
      map.set(newKey, map.get(oldKey));
      map.delete(oldKey);
    }
    for (const [reqId, key] of pendingByReqId.entries()) {
      if (key === oldKey) pendingByReqId.set(reqId, newKey);
    }
    for (const [ticket, key] of ticketToKey.entries()) {
      if (key === oldKey) ticketToKey.set(ticket, newKey);
    }
    if (uiState.has(oldKey)) {
      uiState.set(newKey, uiState.get(oldKey));
      uiState.delete(oldKey);
    }
  }

  return {
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
    markPendingRequest: (reqId, key, options = {}) => {
      if (!reqId || !key) return false;
      const id = String(reqId);
      pendingByReqId.set(id, key);
      retryCounts.set(id, Number.isFinite(Number(options.retryCount)) ? Number(options.retryCount) : 0);
      if (options.pendingId) pendingIdByReqId.set(id, options.pendingId);
      return true;
    },
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
    clearPendingRequest: reqId => {
      if (!reqId) return false;
      const id = String(reqId);
      const had = pendingByReqId.has(id) || pendingIdByReqId.has(id) || retryCounts.has(id);
      pendingByReqId.delete(id);
      pendingIdByReqId.delete(id);
      retryCounts.delete(id);
      return had;
    },
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
    listPlacedOrders: () => Array.from(placedOrderByKey.entries()).map(([key, orderInfo]) => ({
      key,
      orderInfo: snapshot(orderInfo),
      state: cardStates.get(key)
    })),
    clearExecutionStateByKey,
    markTouched: ticker => {
      if (ticker) touchedByTicker.set(ticker, true);
    },
    isTouched: ticker => !!touchedByTicker.get(ticker),
    setFilter: filter => {
      state.filter = filter || '';
    },
    migrateKey
  };
}

module.exports = {
  createCardStateApi
};
