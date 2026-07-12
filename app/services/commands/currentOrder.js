const { Command } = require('./base');

function normNum(value) {
  const num = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function normalizeSide(value) {
  const side = String(value || '').trim().toLowerCase();
  if (side === 'buy' || side === 'b' || side === 'long') return 'buy';
  if (side === 'sell' || side === 's' || side === 'short') return 'sell';
  return '';
}

function pickProvider(executionApi = {}, instrumentType) {
  const explicit = executionApi.execution?.pickProviderName?.(instrumentType);
  if (explicit) return explicit;
  const cfg = executionApi.brokerage?.getExecutionConfig?.() || {};
  return cfg.byInstrumentType?.[instrumentType] || cfg.default || 'simulated';
}

function marketPriceForSide(quote = {}, side) {
  if (side === 'buy' && Number.isFinite(Number(quote.ask))) return Number(quote.ask);
  if (side === 'sell' && Number.isFinite(Number(quote.bid))) return Number(quote.bid);
  if (Number.isFinite(Number(quote.price))) return Number(quote.price);
  return null;
}

class CurrentOrderCommand extends Command {
  constructor(mode, opts = {}) {
    super(mode === 'market' ? ['market-current', 'mc'] : ['limit-current', 'lc']);
    this.mode = mode === 'market' ? 'market' : 'limit';
    this.executionApi = opts.executionApi || {};
  }

  async run(args) {
    const [symbolRaw, sideRaw, qtyRaw, providerRaw, instrumentTypeRaw] = Array.isArray(args) ? args : [];
    const symbol = String(symbolRaw || '').trim().toUpperCase();
    const side = normalizeSide(sideRaw);
    const qty = normNum(qtyRaw);
    const instrumentType = String(instrumentTypeRaw || 'EQ').trim().toUpperCase();
    const provider = providerRaw ? String(providerRaw).trim() : pickProvider(this.executionApi, instrumentType);

    if (!symbol || !side || !Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: `Usage: ${this.name} {symbol} {buy|sell} {qty} [provider] [instrumentType]` };
    }
    if (!provider) {
      return { ok: false, error: `No provider for ${instrumentType}` };
    }

    const queuePlaceOrder = this.executionApi.execution?.queuePlaceOrder;
    if (typeof queuePlaceOrder !== 'function') {
      return { ok: false, error: 'Execution queue is not available' };
    }

    const payload = {
      symbol,
      side,
      qty,
      type: this.mode,
      instrumentType,
      provider,
      meta: {
        hedge: true,
        retry: false,
        hedgeCommand: this.name
      }
    };

    if (this.mode === 'limit') {
      const adapter = this.executionApi.brokerage?.getAdapter?.(provider);
      if (!adapter || typeof adapter.getQuote !== 'function') {
        return { ok: false, error: `Quote adapter is not available for ${provider}` };
      }
      const quote = await adapter.getQuote(symbol);
      const price = marketPriceForSide(quote, side);
      if (!Number.isFinite(price) || price <= 0) {
        return { ok: false, error: `No quote for ${symbol}` };
      }
      payload.price = price;
    }

    const result = await queuePlaceOrder(payload);
    if (!result || result.status === 'rejected' || result.status === 'error') {
      return { ok: false, error: result?.reason || 'Order rejected' };
    }
    return { ok: true, result };
  }
}

module.exports = {
  CurrentOrderCommand,
  normNum,
  normalizeSide,
  marketPriceForSide
};
