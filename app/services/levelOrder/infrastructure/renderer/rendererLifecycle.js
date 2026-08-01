function createLevelOrderRendererLifecycle({
  ipcRenderer,
  pendingByReqId,
  pendingIdByReqId,
  retryCounts,
  pendingExecLabels,
  placedOrderByKey,
  ticketToKey,
  pendingOptionValuations,
  findKeyByTicker,
  detectInstrumentType,
  toast
} = {}) {
  const groups = new Map();
  const childToGroup = new Map();
  const pendingToGroup = new Map();
  const ticketToGroup = new Map();

  function ensureGroup(parentRequestId, key, total = null) {
    if (!parentRequestId || !key) return null;
    let group = groups.get(parentRequestId);
    if (!group) {
      group = {
        parentRequestId,
        key,
        total: Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : null,
        childReqIds: new Set(),
        placedReqIds: new Set(),
        openedTickets: new Set(),
        closedTickets: new Set(),
        profitByTicket: new Map(),
        foundCids: new Set(),
        tickets: new Set()
      };
      groups.set(parentRequestId, group);
    } else {
      group.key = key;
      if (Number.isFinite(Number(total)) && Number(total) > 0) group.total = Number(total);
    }
    return group;
  }

  function findByReqId(reqId) {
    const parent = childToGroup.get(reqId);
    return parent ? groups.get(parent) : null;
  }

  function findByPendingId(pendingId) {
    const parent = pendingToGroup.get(String(pendingId || ''));
    return parent ? groups.get(parent) : null;
  }

  function findOrRegisterFromMeta(meta = {}, fallbackKey) {
    const reqId = meta.requestId;
    const parentRequestId = meta.parentRequestId;
    if (!parentRequestId || !reqId) return null;
    const existing = findByReqId(reqId);
    if (existing) return existing;
    const childCount = Number(meta.childCount);
    const key = fallbackKey || pendingByReqId.get(parentRequestId);
    if (!key) return null;
    const group = ensureGroup(parentRequestId, key, childCount);
    group.childReqIds.add(reqId);
    childToGroup.set(reqId, parentRequestId);
    pendingByReqId.set(reqId, key);
    return group;
  }

  function registerChild(rec = {}, fallbackKey) {
    const meta = {
      ...(rec.order?.meta || {}),
      requestId: rec.order?.meta?.requestId || rec.reqId,
      parentRequestId: rec.order?.meta?.parentRequestId || rec.parentRequestId,
      childCount: rec.order?.meta?.childCount || rec.childCount,
      childIndex: rec.order?.meta?.childIndex || rec.childIndex
    };
    const parentRequestId = meta.parentRequestId;
    const reqId = meta.requestId || rec.reqId;
    if (!parentRequestId || !reqId) return null;
    const childCount = Number(meta.childCount);
    const key = fallbackKey || pendingByReqId.get(parentRequestId) || findKeyByTicker(rec.order?.symbol || rec.order?.ticker);
    if (!key) return null;
    const group = ensureGroup(parentRequestId, key, childCount);
    group.childReqIds.add(reqId);
    childToGroup.set(reqId, parentRequestId);
    if (rec.pendingId) pendingToGroup.set(String(rec.pendingId), parentRequestId);
    if (rec.cid) {
      pendingToGroup.set(String(rec.cid), parentRequestId);
      group.foundCids.add(String(rec.cid));
    }
    pendingByReqId.set(reqId, key);
    return group;
  }

  function registerTicket(group, ticket, key) {
    const normalized = String(ticket || '').trim();
    if (!group || !normalized) return;
    group.tickets.add(normalized);
    ticketToGroup.set(normalized, group.parentRequestId);
    ticketToKey.set(normalized, key || group.key);
  }

  function allPlaced(group) {
    if (!group) return false;
    const total = group.total || group.childReqIds.size;
    return total > 0 && group.placedReqIds.size >= total;
  }

  function allOpened(group) {
    if (!group) return false;
    if (group.lifecycleReady === true) return true;
    const total = group.total || group.childReqIds.size;
    return total > 0 && group.openedTickets.size >= total;
  }

  function allClosed(group) {
    if (!group) return false;
    const total = group.openedTickets.size || group.tickets.size || group.total || group.childReqIds.size;
    return total > 0 && group.closedTickets.size >= total;
  }

  function clearGroup(parentReqId) {
    const group = groups.get(parentReqId);
    groups.delete(parentReqId);
    if (group) {
      for (const childReqId of group.childReqIds) {
        childToGroup.delete(childReqId);
        pendingByReqId.delete(childReqId);
        pendingIdByReqId.delete(childReqId);
        retryCounts.delete(childReqId);
      }
      for (const ticket of group.tickets) {
        ticketToGroup.delete(ticket);
        ticketToKey.delete(ticket);
      }
    }
    for (const [pendingId, parent] of pendingToGroup.entries()) {
      if (parent === parentReqId) pendingToGroup.delete(pendingId);
    }
  }

  function groupsByKey(key) {
    return Array.from(groups.values()).filter(group => group.key === key);
  }

  function clearByKey(key) {
    for (const group of groupsByKey(key)) clearGroup(group.parentRequestId);
  }

  function clearPendingByKey(key) {
    for (const [rid, k] of pendingByReqId.entries()) {
      if (k === key) {
        pendingByReqId.delete(rid);
        pendingIdByReqId.delete(rid);
        retryCounts.delete(rid);
      }
    }
    for (const [parentReqId, group] of groups.entries()) {
      if (group.key !== key) continue;
      groups.delete(parentReqId);
      for (const childReqId of group.childReqIds) childToGroup.delete(childReqId);
      for (const [pendingId, parent] of pendingToGroup.entries()) {
        if (parent === parentReqId) pendingToGroup.delete(pendingId);
      }
      for (const ticket of group.tickets) ticketToGroup.delete(ticket);
    }
    pendingExecLabels.delete(key);
    placedOrderByKey.delete(key);
    pendingOptionValuations.delete(key);
  }

  function cancelTerminalOrders(group, row) {
    if (!group) return;
    const provider = row?.provider || '';
    const symbol = row?.symbol || row?.ticker || '';
    for (const ticket of group.tickets) {
      if (group.openedTickets.has(ticket)) continue;
      ipcRenderer.invoke('execution:cancel-order', { provider, ticket, symbol }).catch(() => {});
    }
  }

  async function closeOpenPositions(key, row) {
    const matchedGroups = groupsByKey(key);
    if (!matchedGroups.length) return false;
    const provider = row?.provider || '';
    const symbol = row?.symbol || row?.ticker || '';
    const instrumentType = row?.instrumentType || detectInstrumentType(symbol);
    let requested = 0;
    const results = [];
    for (const group of matchedGroups) {
      const opened = group.openedTickets.size ? group.openedTickets : group.tickets;
      const tickets = [];
      for (const ticket of opened) {
        if (!group.closedTickets.has(ticket)) tickets.push(ticket);
      }
      const expectedIds = new Set([...group.tickets, ...group.openedTickets, ...group.foundCids]);
      for (const [pendingId, parent] of pendingToGroup.entries()) {
        if (parent === group.parentRequestId) expectedIds.add(pendingId);
      }
      requested += 1;
      try {
        const result = await ipcRenderer.invoke('execution:close-level-order-positions', {
          provider,
          symbol,
          instrumentType,
          tickets,
          expectedIds: [...expectedIds]
        });
        results.push(result);
      } catch (err) {
        results.push({ status: 'error', reason: err?.message || String(err) });
      }
    }
    if (requested > 0) {
      const failed = results.find(result => result?.status === 'error' || result?.status === 'unsupported');
      if (failed) toast(`x ${symbol}: ${failed.reason || 'Close failed'}`);
      else {
        const closed = results.reduce((sum, result) => sum + Number(result?.closed || 0), 0);
        toast(`... ${symbol}: close requested${closed ? ` (${closed})` : ''}`);
      }
      return true;
    }
    toast(`x ${symbol}: no open level order tickets`);
    return false;
  }

  return {
    groups,
    childToGroup,
    pendingToGroup,
    ticketToGroup,
    ensureGroup,
    findByReqId,
    findByPendingId,
    findOrRegisterFromMeta,
    registerChild,
    registerTicket,
    allPlaced,
    allOpened,
    allClosed,
    clearGroup,
    groupsByKey,
    clearByKey,
    clearPendingByKey,
    cancelTerminalOrders,
    closeOpenPositions
  };
}

module.exports = {
  createLevelOrderRendererLifecycle
};
