function registerExecutionIpcHandlers({
  ipcMain,
  getAdapter,
  wireAdapter,
  appendJsonl,
  execLog,
  nowTs = () => Date.now(),
  events,
  instrumentInfo,
  detectInstrumentType,
  resolveProviderName
} = {}) {
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
