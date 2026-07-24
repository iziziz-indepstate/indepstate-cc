const zlib = require('zlib');
const fetch = require('node-fetch');
const { ExecutionAdapter } = require('../../brokerage/comps/base');
const loadConfig = require('../../../config/load');

function cleanConfigValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return /^\$\{?ENV:[A-Z0-9_]+\}?$/i.test(trimmed) ? '' : trimmed;
}

function normalizeCookie(value) {
  const cookie = cleanConfigValue(value);
  if (typeof cookie !== 'string') return '';
  return cookie.replace(/^cookie\s*:\s*/i, '').trim();
}

function loadOptionStratSettings() {
  try {
    return loadConfig('../services/optionstrat/config/optionstrat.json') || {};
  } catch {
    return {};
  }
}

function decodeOptionStratProtected(data) {
  const bytes = Buffer.from(data || []);
  if (bytes.length < 3) {
    throw new Error('Protected payload is too short');
  }
  const fixIndex = bytes[0];
  const xorKey = bytes[1];
  const compressed = Buffer.from(bytes.slice(2));
  if (xorKey !== 0) {
    for (let i = 0; i < compressed.length; i += 1) {
      compressed[i] ^= i % xorKey;
    }
  }
  const plain = Buffer.from(zlib.inflateRawSync(compressed));
  if (fixIndex >= plain.length) {
    throw new Error(`fixIndex ${fixIndex} is outside inflated payload length ${plain.length}`);
  }
  plain[fixIndex] ^= xorKey;
  return plain;
}

async function parseOptionStratResponse(response) {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OptionStrat request failed: ${response.status} ${response.statusText}${text ? ` ${text}` : ''}`);
  }
  if (response.headers?.get?.('x-protect') === '1') {
    const data = await response.buffer();
    return JSON.parse(decodeOptionStratProtected(data).toString('utf8'));
  }
  if (response.headers?.get?.('content-disposition')) {
    return response.buffer();
  }
  const text = await response.text();
  return text === '' ? null : JSON.parse(text);
}

function parseYyMmDd(value) {
  if (!/^\d{6}$/.test(String(value || ''))) {
    throw new Error(`Invalid YYMMDD date: ${value}`);
  }
  const str = String(value);
  return new Date(Date.UTC(2000 + Number(str.slice(0, 2)), Number(str.slice(2, 4)) - 1, Number(str.slice(4, 6))));
}

function formatYyMmDd(date) {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function parseDte(value) {
  const match = String(value || '').trim().match(/^(\d+)DTE$/i);
  if (!match) {
    throw new Error(`Invalid expiration DTE format: ${value}`);
  }
  return Number(match[1]);
}

function chainGroups(response, symbol) {
  const ticker = String(symbol || '').toUpperCase();
  return response?.context?.i?.c?.[ticker] || [];
}

function normalizeOptionChain(response, symbol) {
  const ticker = String(symbol || '').toUpperCase();
  const groups = chainGroups(response, ticker);
  const rows = [];
  for (const group of groups) {
    const strikes = group?.s || {};
    for (const [strikeKey, sides] of Object.entries(strikes)) {
      const strike = Number(strikeKey);
      for (const [sideKey, option] of [['c', 'CALL'], ['p', 'PUT']]) {
        const quote = sides?.[sideKey];
        if (!quote) continue;
        const bid = Number(quote.b);
        const ask = Number(quote.a);
        const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN;
        rows.push({
          underlying: ticker,
          expiration: String(group.exp),
          strike,
          option,
          bid,
          ask,
          mid,
          raw: quote,
          updatedAt: group.ua
        });
      }
    }
  }
  rows.sort((a, b) => a.expiration.localeCompare(b.expiration) || a.strike - b.strike || a.option.localeCompare(b.option));
  return rows;
}

function resolveExpirationByDte(response, symbol, expirationDte, now = new Date()) {
  const dte = parseDte(expirationDte);
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  const targetYyMmDd = formatYyMmDd(target);
  const ticker = String(symbol || '').toUpperCase();
  const groups = chainGroups(response, ticker);
  const found = groups.find(group => String(group?.exp) === targetYyMmDd);
  if (!found) {
    throw new Error(`No ${expirationDte} expiration ${targetYyMmDd} found for ${ticker}`);
  }
  return String(found.exp);
}

function normalizeOptionSide(value) {
  const side = String(value || '').trim().toUpperCase();
  if (side === 'C' || side === 'CALL') return 'CALL';
  if (side === 'P' || side === 'PUT') return 'PUT';
  throw new Error(`Unsupported option side: ${value}`);
}

function formatStrike(strike) {
  const n = Number(strike);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid strike: ${strike}`);
  }
  return Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, '').replace(/\.$/, '');
}

function buildOptionSymbol(ticker, expiration, option, strike) {
  const side = normalizeOptionSide(option) === 'CALL' ? 'C' : 'P';
  return `.${String(ticker || '').toUpperCase()}${expiration}${side}${formatStrike(strike)}`;
}

function signedLegQuantity(leg) {
  const qty = Math.abs(Number(leg.quantity ?? leg.qty ?? 0));
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`Invalid leg quantity for strike ${leg.strike}`);
  }
  const side = String(leg.side || '').trim().toLowerCase();
  if (side === 'sell' || side === 'short') return -qty;
  if (side === 'buy' || side === 'long') return qty;
  const raw = Number(leg.quantity ?? leg.qty);
  if (Number.isFinite(raw) && raw !== 0) return raw;
  throw new Error(`Invalid leg side for strike ${leg.strike}`);
}

function findQuoteMid(rows, { expiration, option, strike }) {
  const wantedOption = normalizeOptionSide(option);
  const wantedStrike = Number(strike);
  const row = rows.find(item =>
    item.expiration === expiration &&
    item.option === wantedOption &&
    Number(item.strike) === wantedStrike
  );
  if (!row) {
    throw new Error(`No quote for ${wantedOption} ${formatStrike(strike)} exp ${expiration}`);
  }
  if (!Number.isFinite(row.mid)) {
    throw new Error(`No bid/ask mid for ${wantedOption} ${formatStrike(strike)} exp ${expiration}`);
  }
  return Number(row.mid.toFixed(4));
}

function parseOptionSymbol(symbol) {
  const match = String(symbol || '').match(/^\.?([A-Z0-9]+)(\d{6})([CP])(.+)$/i);
  if (!match) {
    throw new Error(`Invalid OptionStrat option symbol: ${symbol}`);
  }
  return {
    ticker: match[1].toUpperCase(),
    expiration: match[2],
    option: match[3].toUpperCase() === 'C' ? 'CALL' : 'PUT',
    strike: Number(match[4])
  };
}

function normalizePayoffLegs(legs = []) {
  return (Array.isArray(legs) ? legs : []).map((leg) => {
    const parsed = leg.symbol ? parseOptionSymbol(leg.symbol) : {};
    const option = normalizeOptionSide(leg.option || parsed.option);
    const strike = Number(leg.strike ?? parsed.strike);
    const quantity = Number(leg.quantity ?? leg.qty);
    const basis = Number(leg.basis);
    if (!Number.isFinite(strike)) throw new Error(`Invalid payoff leg strike: ${leg.strike ?? parsed.strike}`);
    if (!Number.isFinite(quantity) || quantity === 0) throw new Error(`Invalid payoff leg quantity: ${leg.quantity ?? leg.qty}`);
    if (!Number.isFinite(basis)) throw new Error(`Invalid payoff leg basis: ${leg.basis}`);
    return { option, strike, quantity, basis };
  });
}

function optionIntrinsic(option, strike, underlyingPrice) {
  return option === 'CALL'
    ? Math.max(0, underlyingPrice - strike)
    : Math.max(0, strike - underlyingPrice);
}

function optionSlopeAtInfinity(option) {
  return option === 'CALL' ? 1 : 0;
}

function payoffAt(legs, underlyingPrice, multiplier = 100) {
  return legs.reduce((sum, leg) => {
    const intrinsic = optionIntrinsic(leg.option, leg.strike, underlyingPrice);
    return sum + ((intrinsic - leg.basis) * leg.quantity * multiplier);
  }, 0);
}

function calculatePayoffSummary(rawLegs, { multiplier = 100 } = {}) {
  const legs = normalizePayoffLegs(rawLegs);
  if (!legs.length) {
    return {
      maxProfit: 0,
      maxLoss: 0,
      isMaxProfitInfinite: false,
      isMaxLossInfinite: false,
      multiplier
    };
  }

  const strikes = Array.from(new Set(legs.map(leg => leg.strike))).sort((a, b) => a - b);
  const points = [0, ...strikes].filter((value, idx, arr) => idx === 0 || value !== arr[idx - 1]);
  const values = points.map(price => payoffAt(legs, price, multiplier));
  let maxProfit = Math.max(...values);
  let minPnl = Math.min(...values);

  const rightSlope = legs.reduce((sum, leg) => sum + optionSlopeAtInfinity(leg.option) * leg.quantity * multiplier, 0);
  const isMaxProfitInfinite = rightSlope > 0;
  const isMaxLossInfinite = rightSlope < 0;

  return {
    maxProfit: isMaxProfitInfinite ? null : Number(maxProfit.toFixed(2)),
    maxLoss: isMaxLossInfinite ? null : Number(Math.abs(minPnl).toFixed(2)),
    isMaxProfitInfinite,
    isMaxLossInfinite,
    multiplier
  };
}

function buildOpenStrategyPayload(order, expiration, rows, account) {
  const ticker = String(order.ticker || order.symbol || '').toUpperCase();
  const strategySymbol = String(order.root || order.chainRoot || ticker).toUpperCase();
  if (!ticker) throw new Error('OptionStrat order requires ticker');
  if (!Array.isArray(order.legs) || order.legs.length === 0) {
    throw new Error('OptionStrat order requires legs');
  }
  const items = order.legs.map((leg) => {
    const option = normalizeOptionSide(leg.option);
    const strike = Number(leg.strike);
    const basis = findQuoteMid(rows, { expiration, option, strike });
    return {
      revision: 0,
      enabled: true,
      symbol: buildOptionSymbol(ticker, expiration, option, strike),
      basis,
      quantity: signedLegQuantity(leg)
    };
  });
  return {
    name: order.name || `${ticker} Option Strategy`,
    isCustomName: order.isCustomName === true,
    description: order.description || '',
    strategy: {
      isCashSecured: order.isCashSecured === true,
      symbol: strategySymbol,
      items
    },
    account
  };
}

function calculateStrategyPayoffSummary(strategy, opts = {}) {
  return calculatePayoffSummary(strategy?.items || [], opts);
}

function calculateStrategyValuation(strategy, rows, { multiplier = 100, currentField = null } = {}) {
  const items = Array.isArray(strategy?.items) ? strategy.items : [];
  if (!items.length) throw new Error('OptionStrat strategy has no items');
  let initialValue = 0;
  let currentValue = 0;
  const legs = items.map((item) => {
    const parsed = parseOptionSymbol(item.symbol);
    const basis = Number(item.basis);
    const quantity = Number(item.quantity);
    if (!Number.isFinite(basis) || !Number.isFinite(quantity)) {
      throw new Error(`Invalid OptionStrat valuation item ${item.symbol}`);
    }
    const fieldCurrent = currentField ? Number(item[currentField]) : NaN;
    const current = Number.isFinite(fieldCurrent)
      ? fieldCurrent
      : (Array.isArray(rows) && rows.length ? findQuoteMid(rows, parsed) : basis);
    initialValue += basis * quantity * multiplier;
    currentValue += current * quantity * multiplier;
    return {
      symbol: item.symbol,
      basis,
      current,
      quantity,
      value: current * quantity * multiplier
    };
  });
  const change = currentValue - initialValue;
  const denom = Math.abs(initialValue);
  return {
    initialValue: Number(initialValue.toFixed(2)),
    currentValue: Number(currentValue.toFixed(2)),
    change: Number(change.toFixed(2)),
    changePct: denom > 0 ? Number(((change / denom) * 100).toFixed(2)) : null,
    multiplier,
    legs
  };
}

function buildCloseStrategyPayload(created, rows) {
  const strategy = created?.strategy || {};
  const symbol = String(strategy.symbol || '').toUpperCase();
  const items = (strategy.items || []).map((item) => {
    const parsed = parseOptionSymbol(item.symbol);
    const close = findQuoteMid(rows, parsed);
    return {
      revision: 1,
      enabled: item.enabled !== false,
      symbol: item.symbol,
      basis: item.basis,
      quantity: item.quantity,
      close
    };
  });
  return {
    isCustomName: created?.isCustomName === true,
    name: created?.name || `${symbol} Option Strategy`,
    description: created?.description || '',
    strategy: {
      isCashSecured: strategy.isCashSecured === true,
      symbol,
      items
    },
    account: created?.account
  };
}

class OptionStratAdapter extends ExecutionAdapter {
  constructor(cfg = {}, providerName = 'optionstrat') {
    super();
    const settings = loadOptionStratSettings();
    this.provider = providerName || 'optionstrat';
    this.baseURL = (cleanConfigValue(cfg.baseURL) || settings.baseURL || 'https://optionstrat.com/api').replace(/\/+$/, '');
    this.cookie = normalizeCookie(cleanConfigValue(cfg.cookie) || settings.cookie || '');
    this.account = cleanConfigValue(cfg.account || cfg.accountId) || settings.account || '';
    this.timeoutMs = Number(cleanConfigValue(cfg.timeoutMs) || settings.timeoutMs) || 10000;
    this.fetch = cfg.fetch || fetch;
    this.now = typeof cfg.now === 'function' ? cfg.now : () => new Date();
    this.useRuntimeSettings = cfg.useRuntimeSettings !== false;
    this.createdStrategies = new Map();
  }

  _runtimeConfig() {
    if (!this.useRuntimeSettings) {
      return {
        baseURL: this.baseURL,
        cookie: this.cookie,
        account: this.account,
        timeoutMs: this.timeoutMs
      };
    }
    const settings = loadOptionStratSettings();
    return {
      baseURL: (settings.baseURL || this.baseURL || 'https://optionstrat.com/api').replace(/\/+$/, ''),
      cookie: normalizeCookie(settings.cookie || this.cookie || ''),
      account: cleanConfigValue(settings.account || this.account || ''),
      timeoutMs: Number(settings.timeoutMs || this.timeoutMs) || 10000
    };
  }

  _headers(extra = {}) {
    const cfg = this._runtimeConfig();
    const headers = {
      Accept: 'application/json',
      ...extra
    };
    if (cfg.cookie) headers.Cookie = cfg.cookie;
    return headers;
  }

  async _request(path, opts = {}) {
    const cfg = this._runtimeConfig();
    const response = await this.fetch(`${cfg.baseURL}${path}`, {
      timeout: cfg.timeoutMs,
      ...opts,
      headers: this._headers(opts.headers)
    });
    return parseOptionStratResponse(response);
  }

  async fetchChain(symbol) {
    return this._request(`/quote/chain/live/${encodeURIComponent(String(symbol || '').toUpperCase())}`);
  }

  _chainSymbol(orderOrStrategy) {
    return String(orderOrStrategy?.root || orderOrStrategy?.chainRoot || orderOrStrategy?.ticker || orderOrStrategy?.symbol || '').toUpperCase();
  }

  async estimateOrder(order) {
    try {
      if (!order || order.instrumentType !== 'OPT') {
        return { status: 'rejected', provider: this.provider, reason: 'OptionStrat adapter accepts only OPT orders.' };
      }
      const runtime = this._runtimeConfig();
      if (!runtime.account) {
        return { status: 'rejected', provider: this.provider, reason: 'OptionStrat account collection id is required.' };
      }
      const ticker = String(order.ticker || order.symbol || '').toUpperCase();
      const chainSymbol = this._chainSymbol(order) || ticker;
      const chain = await this.fetchChain(chainSymbol);
      const expiration = resolveExpirationByDte(chain, chainSymbol, order.expirationDte || order.expiration || '0DTE', this.now());
      const rows = normalizeOptionChain(chain, chainSymbol);
      const payload = buildOpenStrategyPayload({ ...order, ticker }, expiration, rows, runtime.account);
      const payoff = calculateStrategyPayoffSummary(payload.strategy);
      return {
        status: 'ok',
        provider: this.provider,
        payoff,
        estimatedPayoff: payoff,
        raw: { strategy: payload.strategy }
      };
    } catch (err) {
      return { status: 'rejected', provider: this.provider, reason: err?.message || String(err) };
    }
  }

  async placeOrder(order) {
    try {
      if (!order || order.instrumentType !== 'OPT') {
        return { status: 'rejected', provider: this.provider, reason: 'OptionStrat adapter accepts only OPT orders.' };
      }
      const runtime = this._runtimeConfig();
      if (!runtime.account) {
        return { status: 'rejected', provider: this.provider, reason: 'OptionStrat account collection id is required.' };
      }
      const ticker = String(order.ticker || order.symbol || '').toUpperCase();
      const chainSymbol = this._chainSymbol(order) || ticker;
      const chain = await this.fetchChain(chainSymbol);
      const expiration = resolveExpirationByDte(chain, chainSymbol, order.expirationDte || order.expiration || '0DTE', this.now());
      const rows = normalizeOptionChain(chain, chainSymbol);
      const payload = buildOpenStrategyPayload({ ...order, ticker }, expiration, rows, runtime.account);
      const estimatedPayoff = calculateStrategyPayoffSummary(payload.strategy);
      const created = await this._request('/strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const code = created?.code;
      if (!code) {
        return { status: 'rejected', provider: this.provider, reason: 'OptionStrat response did not include code', raw: created };
      }
      if (order.root) created.root = String(order.root).toUpperCase();
      if (chainSymbol) created.chainRoot = chainSymbol;
      const payoff = calculateStrategyPayoffSummary(created.strategy || payload.strategy);
      const valuation = calculateStrategyValuation(created.strategy || payload.strategy, []);
      created.payoff = payoff;
      created.estimatedPayoff = estimatedPayoff;
      created.valuation = valuation;
      this.createdStrategies.set(String(code), created);
      return { status: 'ok', provider: this.provider, providerOrderId: String(code), payoff, valuation, raw: created };
    } catch (err) {
      return { status: 'rejected', provider: this.provider, reason: err?.message || String(err) };
    }
  }

  async getStrategyValuation(dealId, symbol) {
    try {
      const id = String(dealId || '').trim();
      const created = this.createdStrategies.get(id);
      if (!created) {
        return { status: 'error', provider: this.provider, reason: `No stored OptionStrat strategy for ${id}` };
      }
      const ticker = String(symbol || created?.strategy?.symbol || '').toUpperCase();
      const chainSymbol = this._chainSymbol(created) || ticker;
      const chain = await this.fetchChain(chainSymbol);
      const rows = normalizeOptionChain(chain, chainSymbol);
      const valuation = calculateStrategyValuation(created.strategy, rows);
      created.valuation = valuation;
      this.createdStrategies.set(id, created);
      return { status: 'ok', provider: this.provider, valuation };
    } catch (err) {
      return { status: 'error', provider: this.provider, reason: err?.message || String(err) };
    }
  }

  async cancelOrder(dealId, symbol) {
    try {
      const id = String(dealId || '').trim();
      const created = this.createdStrategies.get(id);
      if (!created) {
        return { status: 'error', provider: this.provider, reason: `No stored OptionStrat strategy for ${id}` };
      }
      const ticker = String(symbol || created?.strategy?.symbol || '').toUpperCase();
      const chainSymbol = this._chainSymbol(created) || ticker;
      const chain = await this.fetchChain(chainSymbol);
      const rows = normalizeOptionChain(chain, chainSymbol);
      const payload = buildCloseStrategyPayload(created, rows);
      const valuation = calculateStrategyValuation(payload.strategy, [], { currentField: 'close' });
      const updated = await this._request(`/strategy/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const raw = {
        ...created,
        ...(updated || payload),
        root: created.root,
        chainRoot: created.chainRoot,
        valuation
      };
      this.createdStrategies.set(id, raw);
      return { status: 'ok', provider: this.provider, valuation, raw };
    } catch (err) {
      return { status: 'error', provider: this.provider, reason: err?.message || String(err) };
    }
  }

  async getQuote() {
    return { price: 1, bid: 1, ask: 1, tickSize: 0.01 };
  }

  async getInstrumentMetadata() {
    return { tickSize: 0.01, quantityStep: 1, minQty: 1, contractSize: 100, sources: { tickSize: 'optionstrat' } };
  }
}

module.exports = {
  OptionStratAdapter,
  decodeOptionStratProtected,
  parseOptionStratResponse,
  parseYyMmDd,
  formatYyMmDd,
  parseDte,
  chainGroups,
  normalizeOptionChain,
  resolveExpirationByDte,
  buildOptionSymbol,
  parseOptionSymbol,
  normalizePayoffLegs,
  payoffAt,
  calculatePayoffSummary,
  calculateStrategyPayoffSummary,
  calculateStrategyValuation,
  buildOpenStrategyPayload,
  buildCloseStrategyPayload,
  findQuoteMid,
  signedLegQuantity
};
