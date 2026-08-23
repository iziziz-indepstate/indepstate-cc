function registerExecutionIpcHandlers({
  ipcMain,
  executionService,
  getAdapter,
  wireAdapter,
  appendJsonl,
  execLog,
  nowTs = () => Date.now(),
  events,
  closeControllers,
  instrumentInfo,
  detectInstrumentType,
  resolveProviderName
} = {}) {
  const lifecycleControllers = Array.isArray(closeControllers) ? closeControllers.filter(Boolean) : [];

  if (typeof executionService?.previewPlaceOrder === 'function') {
    ipcMain.handle('execution:preview-place-order', async (_evt, payload = {}) => executionService.previewPlaceOrder(payload));
  }

  function notifyCloseControllers(context) {
    for (const controller of lifecycleControllers) {
      const fn = controller?.onCancelOrderResult;
      if (typeof fn !== 'function') continue;
      try {
        fn.call(controller, context);
      } catch (err) {
        console.warn(`[execution] ${controller.id || 'close controller'} onCancelOrderResult failed:`, err?.message || String(err));
      }
    }
  }

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
      if (res.status === 'ok') {
        notifyCloseControllers({
          payload,
          providerName,
          ticket,
          symbol,
          name,
          result: res,
          events
        });
      }
      return res;
    } catch (err) {
      const reason = err?.message || String(err || '');
      appendJsonl(execLog, { t: nowTs(), kind: 'cancel', provider: providerName, ticket, symbol, error: reason });
      return { status: 'error', provider: providerName, reason };
    }
  });

  ipcMain.handle('execution:close-position', async (_evt, payload = {}) => {
    const providerNameRaw = payload.provider;
    const ticketRaw = payload.ticket;
    const symbolRaw = payload.symbol;
    const providerName = typeof providerNameRaw === 'string' ? providerNameRaw : String(providerNameRaw || '');
    const ticket = typeof ticketRaw === 'string' ? ticketRaw : String(ticketRaw || '');
    const symbol = typeof symbolRaw === 'string' ? symbolRaw : (symbolRaw == null ? undefined : String(symbolRaw));
    const reason = payload.reason || 'renderer.close-position';

    if (!providerName || !ticket) {
      return { status: 'error', reason: 'provider and ticket required' };
    }

    try {
      const adapter = getAdapter(providerName);
      wireAdapter(adapter, providerName);
      if (typeof adapter?.closePosition !== 'function') {
        const res = { status: 'unsupported', provider: providerName, reason: 'Adapter closePosition is not supported' };
        appendJsonl(execLog, { t: nowTs(), kind: 'close-position', provider: providerName, ticket, symbol, result: res });
        return res;
      }
      const position = {
        ticket,
        symbol,
        provider: providerName,
        side: payload.side,
        snapshot: payload.snapshot
      };
      const result = await adapter.closePosition(position, reason);
      const res = result || { status: 'ok', provider: providerName };
      appendJsonl(execLog, { t: nowTs(), kind: 'close-position', provider: providerName, ticket, symbol, reason, result: res });
      return res;
    } catch (err) {
      const reasonText = err?.message || String(err || '');
      appendJsonl(execLog, { t: nowTs(), kind: 'close-position', provider: providerName, ticket, symbol, error: reasonText });
      return { status: 'error', provider: providerName, reason: reasonText };
    }
  });

  ipcMain.handle('instrument:get', async (_evt, arg) => {
    try {
      const symbol = typeof arg === 'object' ? arg.symbol : arg;
      const provider = typeof arg === 'object' ? arg.provider : undefined;
      const instrumentType = detectInstrumentType(String(symbol || ''));
      const providerName = resolveProviderName({ provider, payload: typeof arg === 'object' ? arg : {}, symbol, instrumentType });
      return await instrumentInfo.get(
        { provider: providerName, symbol, instrumentType, payload: typeof arg === 'object' ? arg : {} },
        { forceQuote: typeof arg === 'object' && arg.forceQuote === true }
      );
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
