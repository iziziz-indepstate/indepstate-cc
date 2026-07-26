function defaultExtractCid(value) {
  const match = String(value || '').match(/cid[:=]\s*([a-f0-9]{8,})/i);
  return match ? match[1] : undefined;
}

function createAdapterLifecycleBridge({
  servicesApi,
  events,
  appendJsonl,
  execLog,
  nowTs = () => Date.now(),
  getMainWindow = () => null,
  wiredAdapters = new WeakSet(),
  pendingIndex,
  trackerPending,
  trackerIndex,
  confirmedOrderByTicket,
  confirmedOrderByCid,
  groupedOrderLifecycles,
  levelOrderPositionMonitors,
  levelOrderChildCid,
  emitLevelOrderPositionsReadyIfComplete,
  extractCid = defaultExtractCid
} = {}) {
  if (!pendingIndex || !trackerPending || !trackerIndex) {
    throw new Error('adapter lifecycle bridge requires pending/tracker indexes');
  }

  function send(channel, payload) {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }

  function wireAdapter(adapter, providerName) {
    if (!adapter?.on || wiredAdapters.has(adapter)) return;
    if (typeof adapter.setExecutionRetryPolicy === 'function' && servicesApi?.executionRetry) {
      adapter.setExecutionRetryPolicy(servicesApi.executionRetry);
    }
    wiredAdapters.add(adapter);

    adapter.on('order:confirmed', ({ pendingId, ticket, mtOrder }) => {
      const rec = pendingIndex.get(pendingId);
      if (!rec) return;
      pendingIndex.delete(pendingId);

      const payload = {
        ts: nowTs(),
        reqId: rec.reqId,
        provider: providerName,
        status: 'ok',
        providerOrderId: String(ticket || ''),
        pendingId,
        parentRequestId: rec.order?.meta?.parentRequestId,
        childIndex: rec.order?.meta?.childIndex,
        childCount: rec.order?.meta?.childCount,
        strategyId: rec.order?.meta?.strategyId,
        order: rec.order
      };
      const normalizedTicket = String(ticket || '');
      const parentRequestId = rec.order?.meta?.parentRequestId;
      const monitor = parentRequestId ? levelOrderPositionMonitors?.get(parentRequestId) : null;
      if (monitor && normalizedTicket) {
        const child = monitor.children.find(item => item.requestId === rec.reqId || levelOrderChildCid?.(item) === String(pendingId));
        if (child) child.providerOrderId = normalizedTicket;
      }
      if (parentRequestId && normalizedTicket) {
        groupedOrderLifecycles?.registerTicket(parentRequestId, {
          provider: providerName,
          symbol: rec.order?.symbol || rec.order?.ticker || '',
          expectedCount: rec.order?.meta?.childCount,
          ticket: normalizedTicket,
          cid: pendingId,
          qty: rec.order?.qty
        });
      }
      if (normalizedTicket) confirmedOrderByTicket?.set(normalizedTicket, rec.order);
      if (pendingId) confirmedOrderByCid?.set(String(pendingId), rec.order);
      if (rec.cid) confirmedOrderByCid?.set(String(rec.cid), rec.order);
      if (rec.order?.meta?.cid) confirmedOrderByCid?.set(String(rec.order.meta.cid), rec.order);
      events?.emit('order:confirmed', { pendingId, ticket: normalizedTicket, order: rec.order, mtOrder, provider: providerName });
      appendJsonl?.(execLog, { t: payload.ts, kind: 'confirm', ...payload, mtOrder });
      send('execution:result', payload);
      if (parentRequestId) emitLevelOrderPositionsReadyIfComplete?.(parentRequestId);
      const info = trackerPending.get(rec.reqId);
      if (info) {
        const cid = extractCid(mtOrder?.comment || '');
        if (cid) info.cid = cid;
        trackerIndex.set(normalizedTicket, info);
        trackerPending.delete(rec.reqId);
      }
      console.log('[EXEC][CONFIRMED]', { reqId: rec.reqId, ticket: payload.providerOrderId });
    });

    adapter.on('order:rejected', ({ pendingId, reason, msg }) => {
      const rec = pendingIndex.get(pendingId);
      if (!rec) return;
      pendingIndex.delete(pendingId);

      const payload = {
        ts: nowTs(),
        reqId: rec.reqId,
        provider: providerName,
        status: 'rejected',
        reason: reason || 'EA error',
        pendingId,
        order: rec.order
      };
      appendJsonl?.(execLog, { t: payload.ts, kind: 'reject', ...payload, msg });
      events?.emit('order:rejected', { pendingId, reason: payload.reason, order: rec.order, provider: providerName });
      send('execution:result', payload);
      trackerPending.delete(rec.reqId);
      console.log('[EXEC][REJECTED]', { reqId: rec.reqId, reason: payload.reason });
    });

    adapter.on('order:retry', ({ pendingId, count }) => {
      const rec = pendingIndex.get(pendingId);
      if (!rec) return;
      send('execution:retry', { reqId: rec.reqId, pendingId, count });
    });

    adapter.on('position:opened', ({ ticket, order, origOrder }) => {
      const normalizedTicket = String(ticket || '');
      const cid = extractCid(order?.comment || order?.comment_string || order?.clientOrderId || order?.id || '');
      const enrichedOrigOrder = origOrder
        || confirmedOrderByTicket?.get(normalizedTicket)
        || (cid ? confirmedOrderByCid?.get(cid) : null)
        || (cid ? pendingIndex.get(cid)?.order : null);
      servicesApi?.positions?.recordOpened?.({ ticket, order, origOrder: enrichedOrigOrder, provider: providerName });
      events?.emit('position:opened', { ticket, order, origOrder: enrichedOrigOrder, provider: providerName });
      const parentRequestId = enrichedOrigOrder?.meta?.parentRequestId;
      console.log('[EXEC][POSITION_OPENED]', {
        provider: providerName,
        ticket: normalizedTicket,
        parentRequestId,
        cid: enrichedOrigOrder?.meta?.cid || cid
      });
      if (parentRequestId && normalizedTicket) {
        groupedOrderLifecycles?.markOpened(parentRequestId, {
          provider: providerName,
          symbol: enrichedOrigOrder?.symbol || enrichedOrigOrder?.ticker || order?.symbol || '',
          expectedCount: enrichedOrigOrder?.meta?.childCount,
          ticket: normalizedTicket,
          cid: enrichedOrigOrder?.meta?.cid,
          qty: enrichedOrigOrder?.qty ?? order?.size
        });
        emitLevelOrderPositionsReadyIfComplete?.(parentRequestId);
      }
      send('position:opened', { ticket, order, origOrder: enrichedOrigOrder, provider: providerName });
    });

    adapter.on('position:closed', ({ ticket, trade }) => {
      servicesApi?.positions?.recordClosed?.({ ticket, trade, profit: trade?.profit, provider: providerName });
      events?.emit('position:closed', { ticket, trade, provider: providerName });
      const profit = trade?.profit;
      if (trackerIndex.get(String(ticket))) trackerIndex.delete(String(ticket));
      send('position:closed', { ticket, trade, profit, provider: providerName });
    });

    adapter.on('order:cancelled', ({ ticket }) => {
      servicesApi?.positions?.recordCancelled?.({ ticket, provider: providerName });
      events?.emit('order:cancelled', { ticket, provider: providerName });
      trackerIndex.delete(String(ticket));
      groupedOrderLifecycles?.removeTicket(ticket, providerName);
      send('order:cancelled', { ticket, provider: providerName });
    });
  }

  return { wireAdapter };
}

module.exports = {
  createAdapterLifecycleBridge,
  defaultExtractCid
};
