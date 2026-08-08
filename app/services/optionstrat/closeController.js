function normalizeText(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function isOptionStratProvider(value) {
  return normalizeText(value).toLowerCase() === 'optionstrat';
}

function isOptionStratClose({ providerName, result } = {}) {
  return isOptionStratProvider(providerName)
    || isOptionStratProvider(result?.provider)
    || Boolean(result?.raw?.strategy);
}

function createOptionStratCloseController({ positions, events } = {}) {
  return {
    id: 'optionstrat',

    onCancelOrderResult({ providerName, ticket, symbol, name, result, events: contextEvents } = {}) {
      if (result?.status && result.status !== 'ok') return null;
      if (!isOptionStratClose({ providerName, result })) return null;
      const provider = normalizeText(providerName) || normalizeText(result?.provider);
      const normalizedTicket = normalizeText(ticket || result?.ticket || result?.providerOrderId);
      if (!provider || !normalizedTicket) return null;

      const order = {};
      const normalizedSymbol = normalizeText(symbol || result?.symbol);
      const normalizedName = normalizeText(name || result?.name || result?.order?.name);
      if (normalizedSymbol) order.symbol = normalizedSymbol;
      if (normalizedName) order.name = normalizedName;

      let closed = null;
      if (typeof positions?.recordClosed === 'function') {
        closed = positions.recordClosed({
          ticket: normalizedTicket,
          provider,
          trade: result?.valuation
            ? { pnlStatus: 'reported', valuation: result.valuation }
            : { pnlStatus: 'closed' },
          order
        });
      }

      const lifecycleEvents = contextEvents || events;
      lifecycleEvents?.emit?.('order:closed', {
        provider,
        ticket: normalizedTicket,
        symbol: normalizedSymbol,
        order: normalizedName ? { name: normalizedName } : {},
        result: { ...(result || {}), provider }
      });

      return closed;
    }
  };
}

module.exports = {
  createOptionStratCloseController,
  isOptionStratClose
};
