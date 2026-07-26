function registerExecutionIpcHandlers({
  ipcMain,
  executionService,
  levelOrderService,
  getAdapter,
  wireAdapter,
  appendJsonl,
  execLog,
  nowTs = () => Date.now(),
  events,
  buildOptionStratHedgePayload,
  servicesApi,
  instrumentInfo,
  detectInstrumentType,
  resolveProviderName,
  normalizeOrderPayload
} = {}) {
  ipcMain.handle('optionstrat:button-event', async (_evt, payload = {}) => {
    const { eventName, payload: eventPayload } = buildOptionStratHedgePayload(payload.action, payload.row || {});
    if (!eventPayload.hedgeOpenSide) {
      return { ok: false, reason: 'Unsupported OptionStrat strategy for hedge automation' };
    }
    if (servicesApi.actionBus && typeof servicesApi.actionBus.emit === 'function') {
      servicesApi.actionBus.emit(eventName, eventPayload);
      return { ok: true, event: eventName, payload: eventPayload };
    }
    return { ok: false, reason: 'actions-bus is not available' };
  });

  ipcMain.handle('level-order:place', async (_evt, payload = {}) => levelOrderService.queueLevelOrder(payload));
  ipcMain.handle('execution:stop-retry', async (_evt, reqId) => levelOrderService.stopRetry(reqId));
  ipcMain.handle('execution:close-level-order-positions', async (_evt, payload = {}) => levelOrderService.closeLevelOrderPositions(payload));

  ipcMain.handle('execution:cancel-order', async (_evt, payload = {}) => {
    const providerNameRaw = payload.provider;
    const ticketRaw = payload.ticket;
    const symbolRaw = payload.symbol;
    const nameRaw = payload.name || payload.order?.name;
    const providerName = typeof providerNameRaw === 'string' ? providerNameRaw : String(providerNameRaw || '');
    const ticket = typeof ticketRaw === 'string' ? ticketRaw : String(ticketRaw || '');
    const symbol = typeof symbolRaw === 'string' ? symbolRaw : (symbolRaw == null ? undefined : String(symbolRaw));
    const name = typeof nameRaw === 'string' ? nameRaw : (nameRaw == null ? undefined : String(nameRaw));

    if (!providerName || !ticket) {
      return { status: 'error', reason: 'provider and ticket required' };
    }

    try {
      const adapter = getAdapter(providerName);
      wireAdapter(adapter, providerName);
      if (typeof adapter?.cancelOrder !== 'function') {
        const res = { status: 'unsupported', provider: providerName };
        appendJsonl(execLog, { t: nowTs(), kind: 'cancel', provider: providerName, ticket, symbol, result: res });
        return res;
      }
      const result = await adapter.cancelOrder(ticket, symbol);
      appendJsonl(execLog, { t: nowTs(), kind: 'cancel', provider: providerName, ticket, symbol, result });
      const res = result || { status: 'ok', provider: providerName };
      const isOptionStratClose = String(providerName || '').toLowerCase() === 'optionstrat' || !!res?.raw?.strategy;
      if (res.status === 'ok' && isOptionStratClose) {
        events.emit('order:closed', {
          provider: providerName,
          ticket,
          symbol,
          order: name ? { name } : undefined,
          result: { ...res, provider: res.provider || providerName }
        });
      }
      return res;
    } catch (err) {
      const reason = err?.message || String(err || '');
      appendJsonl(execLog, { t: nowTs(), kind: 'cancel', provider: providerName, ticket, symbol, error: reason });
      return { status: 'error', provider: providerName, reason };
    }
  });

  ipcMain.handle('optionstrat:estimate', async (_evt, payload = {}) => {
    const order = normalizeOrderPayload({
      ...payload,
      instrumentType: 'OPT',
      provider: payload.provider || payload.meta?.provider || 'optionstrat'
    });
    const providerName = executionService.resolveOrderProviderName
      ? executionService.resolveOrderProviderName(order)
      : resolveProviderName({ payload: order, symbol: order?.symbol || order?.ticker, instrumentType: order?.instrumentType, meta: order?.meta });
    try {
      const adapter = getAdapter(providerName);
      wireAdapter(adapter, providerName);
      if (typeof adapter?.estimateOrder !== 'function') {
        return { status: 'unsupported', provider: providerName };
      }
      return await adapter.estimateOrder(order);
    } catch (err) {
      return { status: 'rejected', provider: providerName, reason: err?.message || String(err) };
    }
  });

  ipcMain.handle('optionstrat:valuation', async (_evt, payload = {}) => {
    const providerName = payload.provider || payload.meta?.provider || 'optionstrat';
    const ticket = typeof payload.ticket === 'string' ? payload.ticket : String(payload.ticket || '');
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : (payload.symbol == null ? undefined : String(payload.symbol));
    if (!ticket) return { status: 'error', provider: providerName, reason: 'ticket required' };
    try {
      const adapter = getAdapter(providerName);
      wireAdapter(adapter, providerName);
      if (typeof adapter?.getStrategyValuation !== 'function') {
        return { status: 'unsupported', provider: providerName };
      }
      return await adapter.getStrategyValuation(ticket, symbol);
    } catch (err) {
      return { status: 'error', provider: providerName, reason: err?.message || String(err) };
    }
  });

  ipcMain.handle('instrument:get', async (_evt, arg) => {
    try {
      const symbol = typeof arg === 'object' ? arg.symbol : arg;
      const provider = typeof arg === 'object' ? arg.provider : undefined;
      const instrumentType = detectInstrumentType(String(symbol || ''));
      const providerName = resolveProviderName({ provider, payload: typeof arg === 'object' ? arg : {}, symbol, instrumentType });
      return await instrumentInfo.get({ provider: providerName, symbol, instrumentType, payload: typeof arg === 'object' ? arg : {} });
    } catch {
      return null;
    }
  });

  ipcMain.handle('instrument:forget', async (_evt, arg) => {
    try {
      const symbol = typeof arg === 'object' ? arg.symbol : arg;
      const provider = typeof arg === 'object' ? arg.provider : undefined;
      const instrumentType = detectInstrumentType(String(symbol || ''));
      const providerName = resolveProviderName({ provider, payload: typeof arg === 'object' ? arg : {}, symbol, instrumentType });
      return await instrumentInfo.forget({ provider: providerName, symbol, instrumentType, payload: typeof arg === 'object' ? arg : {} });
    } catch {
      return false;
    }
  });
}

module.exports = {
  registerExecutionIpcHandlers
};
