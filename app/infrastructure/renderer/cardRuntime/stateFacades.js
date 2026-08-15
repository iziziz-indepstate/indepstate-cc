function snapshot(value) {
  return value && typeof value === 'object' ? { ...value } : value;
}

function callAll(apis, method, args) {
  let result = false;
  for (const api of apis) {
    if (typeof api?.[method] !== 'function') continue;
    const value = api[method](...args);
    result = value || result;
  }
  return result;
}

function firstValue(apis, method, args) {
  for (const api of apis) {
    if (typeof api?.[method] !== 'function') continue;
    const value = api[method](...args);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function listPlacedOrders(apis, options) {
  const byKey = new Map();
  for (const api of apis) {
    if (typeof api?.listPlacedOrders !== 'function') continue;
    const entries = api.listPlacedOrders(options) || [];
    for (const entry of entries) {
      if (!entry?.key || byKey.has(entry.key)) continue;
      byKey.set(entry.key, {
        key: entry.key,
        orderInfo: snapshot(entry.orderInfo),
        state: entry.state
      });
    }
  }
  return Array.from(byKey.values());
}

function createOrderStateFacades(...sources) {
  const apis = sources.flat().filter(Boolean);
  return {
    pendingRequestLabels: {
      markPendingRequest: (...args) => callAll(apis, 'markPendingRequest', args),
      resolvePendingKey: (...args) => firstValue(apis, 'resolvePendingKey', args),
      setPendingId: (...args) => callAll(apis, 'setPendingId', args),
      getPendingId: (...args) => firstValue(apis, 'getPendingId', args),
      getRetryCount: (...args) => firstValue(apis, 'getRetryCount', args),
      findPendingRequestIdByKey: (...args) => firstValue(apis, 'findPendingRequestIdByKey', args),
      clearPendingRequest: (...args) => callAll(apis, 'clearPendingRequest', args),
      clearPendingByKey: (...args) => callAll(apis, 'clearPendingByKey', args),
      setPendingExecLabel: (...args) => callAll(apis, 'setPendingExecLabel', args),
      getPendingExecLabel: (...args) => firstValue(apis, 'getPendingExecLabel', args),
      clearPendingExecLabel: (...args) => callAll(apis, 'clearPendingExecLabel', args)
    },
    placedOrderLookup: {
      markPlacedOrder: (...args) => callAll(apis, 'markPlacedOrder', args),
      getPlacedOrder: (...args) => firstValue(apis, 'getPlacedOrder', args),
      deletePlacedOrder: (...args) => callAll(apis, 'deletePlacedOrder', args),
      listPlacedOrders: (options = {}) => listPlacedOrders(apis, options)
    },
    cardVisualState: {
      getCardState: (...args) => firstValue(apis, 'getCardState', args),
      setCardState: (...args) => callAll(apis, 'setCardState', args),
      clearCardState: (...args) => callAll(apis, 'clearCardState', args),
      clearExecutionStateByKey: (...args) => callAll(apis, 'clearExecutionStateByKey', args)
    },
    ticketBinding: {
      resolveTicketKey: (...args) => firstValue(apis, 'resolveTicketKey', args),
      bindTicket: (...args) => callAll(apis, 'bindTicket', args),
      unbindTicket: (...args) => callAll(apis, 'unbindTicket', args)
    }
  };
}

function createLegacyOrderStateCompatApi(facades = {}) {
  const pending = facades.pendingRequestLabels || {};
  const placed = facades.placedOrderLookup || {};
  const visual = facades.cardVisualState || {};
  const tickets = facades.ticketBinding || {};
  return {
    getCardState: (...args) => visual.getCardState?.(...args),
    setCardState: (...args) => visual.setCardState?.(...args),
    clearCardState: (...args) => visual.clearCardState?.(...args),
    setPendingExecLabel: (...args) => pending.setPendingExecLabel?.(...args),
    getPendingExecLabel: (...args) => pending.getPendingExecLabel?.(...args),
    clearPendingExecLabel: (...args) => pending.clearPendingExecLabel?.(...args),
    markPendingRequest: (...args) => pending.markPendingRequest?.(...args),
    resolvePendingKey: (...args) => pending.resolvePendingKey?.(...args),
    setPendingId: (...args) => pending.setPendingId?.(...args),
    getPendingId: (...args) => pending.getPendingId?.(...args),
    getRetryCount: (...args) => pending.getRetryCount?.(...args),
    findPendingRequestIdByKey: (...args) => pending.findPendingRequestIdByKey?.(...args),
    clearPendingRequest: (...args) => pending.clearPendingRequest?.(...args),
    clearPendingByKey: (...args) => pending.clearPendingByKey?.(...args),
    markPlacedOrder: (...args) => placed.markPlacedOrder?.(...args),
    getPlacedOrder: (...args) => placed.getPlacedOrder?.(...args),
    deletePlacedOrder: (...args) => placed.deletePlacedOrder?.(...args),
    listPlacedOrders: (...args) => placed.listPlacedOrders?.(...args),
    resolveTicketKey: (...args) => tickets.resolveTicketKey?.(...args),
    bindTicket: (...args) => tickets.bindTicket?.(...args),
    unbindTicket: (...args) => tickets.unbindTicket?.(...args),
    clearExecutionStateByKey: (...args) => visual.clearExecutionStateByKey?.(...args)
  };
}

module.exports = {
  createOrderStateFacades,
  createLegacyOrderStateCompatApi
};
