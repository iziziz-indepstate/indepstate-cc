function providerCanResolveRiskQty(providerName, adapter) {
  const p = String(providerName || '').toLowerCase();
  const id = String(adapter?.exchangeId || '').toLowerCase();
  return p.includes('binance') || ['binance', 'binanceusdm', 'binance-futures', 'binancefutures'].includes(id);
}

function createProviderResolution({ resolveProvider } = {}) {
  function resolveProviderName(context = {}) {
    if (typeof resolveProvider === 'function') {
      return resolveProvider(context).provider;
    }
    const explicit = context.provider || context.payload?.provider || context.row?.provider || context.meta?.provider;
    return String(explicit || 'simulated').trim().toLowerCase();
  }

  function resolveOrderProviderName(order) {
    return resolveProviderName({
      payload: order,
      symbol: order?.symbol || order?.ticker,
      instrumentType: order?.instrumentType,
      meta: order?.meta
    });
  }

  return {
    resolveProviderName,
    resolveOrderProviderName,
    providerCanResolveRiskQty
  };
}

module.exports = {
  providerCanResolveRiskQty,
  createProviderResolution
};
