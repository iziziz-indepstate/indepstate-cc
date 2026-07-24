// services/brokerage-adapter-ibkr/comps/ibkr.js
// Interactive Brokers adapter using the TWS / IB Gateway socket API.
const { EventEmitter } = require('events');
const { ExecutionAdapter } = require('../../brokerage/comps/base');

const DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'paper',
  debug: false,
  host: '127.0.0.1',
  port: 4002,
  clientId: 12,
  accountId: '',
  defaultTif: 'DAY',
  quoteTimeoutMs: 5000,
  contractResolveTimeoutMs: 5000,
  commissionReportTimeoutMs: 10000,
  trackExternalExecutions: true,
  marketDataType: 3,
  defaultTickSize: null,
  snapshotQuotes: false,
  contractResolution: {
    enabled: true,
    profiles: {
      STK: {
        secType: 'STK',
        exchange: 'SMART',
        currency: 'USD',
        preferredPrimaryExchanges: ['NASDAQ', 'NYSE', 'ARCA', 'AMEX'],
      },
      CFD: {
        secType: 'CFD',
        exchange: 'SMART',
        currency: 'USD',
        preferredPrimaryExchanges: [],
      },
    },
    profileBySymbol: {},
    defaultProfile: 'STK',
  },
  autoConnect: true,
});

const SENSITIVE_KEY_RE = /(?:token|secret|password|credential|key)$/i;
const FINAL_CANCEL_STATUSES = new Set(['Cancelled', 'ApiCancelled']);
const ACCEPTED_STATUSES = new Set(['PendingSubmit', 'PreSubmitted', 'Submitted', 'Filled']);
const REJECTED_STATUSES = new Set(['Inactive', 'ApiCancelled', 'Cancelled']);
const TICK_PRICE_FIELDS = Object.freeze({
  1: 'bid',
  2: 'ask',
  4: 'last',
  9: 'close',
  66: 'bid', // delayed bid
  67: 'ask', // delayed ask
  68: 'last', // delayed last
  75: 'close', // delayed close
});
const MARKET_DATA_PERMISSION_CODES = new Set([354, 10167]);
const MARKET_DATA_DIAGNOSTIC_ERROR_LABELS = Object.freeze({
  354: 'not-subscribed',
  10090: 'partial-data-or-missing-subscription',
  10167: 'requested-market-data-not-subscribed',
  10186: 'delayed-market-data-not-enabled',
  10197: 'competing-live-session',
});
const QUOTE_DIAGNOSTIC_SAMPLE_LIMIT = 5;
const PRIMARY_EXCHANGE_ALIASES = Object.freeze({
  NASDAQ: new Set(['NASDAQ', 'ISLAND', 'NMS']),
  NYSE: new Set(['NYSE']),
  ARCA: new Set(['ARCA', 'NYSEARCA']),
  AMEX: new Set(['AMEX', 'NYSEAMEX']),
});

function normalizeString(value) {
  return value == null ? '' : String(value).trim();
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteRealizedPnl(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) < 1e100 ? n : null;
}

function executionFamily(execId) {
  const value = normalizeString(execId);
  const cut = value.lastIndexOf('.');
  return cut > 0 ? value.slice(0, cut) : value;
}

function executionRevision(execId) {
  const value = normalizeString(execId);
  const cut = value.lastIndexOf('.');
  const revision = cut >= 0 ? Number(value.slice(cut + 1)) : 0;
  return Number.isFinite(revision) ? revision : 0;
}

function normalizeExecutionSide(side) {
  const value = normalizeString(side).toUpperCase();
  if (value === 'BOT' || value === 'BUY') return 'BUY';
  if (value === 'SLD' || value === 'SELL') return 'SELL';
  return '';
}

function contractIdentity(contract = {}) {
  const conId = Number(contract.conId);
  if (Number.isInteger(conId) && conId > 0) return `conid:${conId}`;
  return [contract.symbol, contract.secType, contract.currency, contract.exchange]
    .map(value => normalizeString(value).toUpperCase())
    .join('|');
}

function ibkrExecutionTime(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function safeClone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(safeClone);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : safeClone(val);
  }
  return out;
}

function safeContractSummary(contract = {}) {
  const out = {};
  for (const key of ['conId', 'symbol', 'secType', 'exchange', 'currency', 'primaryExchange', 'localSymbol', 'tradingClass']) {
    if (contract[key] !== undefined && contract[key] !== '') out[key] = contract[key];
  }
  return out;
}

function createContextError(message, context = {}) {
  const safeContext = safeClone(context);
  const err = new Error(`${message}${Object.keys(safeContext).length ? ` (${JSON.stringify(safeContext)})` : ''}`);
  err.context = safeContext;
  return err;
}


function normalizePreferredPrimaryExchanges(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed.split(',').map(part => part.trim()).filter(Boolean);
  }
  return value;
}

function normalizeContractResolutionProfile(profile = {}) {
  const secType = normalizeString(profile.secType).toUpperCase();
  const exchange = normalizeString(profile.exchange).toUpperCase();
  const currency = normalizeString(profile.currency).toUpperCase();
  const preferredPrimaryExchanges = normalizePreferredPrimaryExchanges(profile.preferredPrimaryExchanges);
  return {
    secType,
    exchange,
    currency,
    preferredPrimaryExchanges: Array.isArray(preferredPrimaryExchanges)
      ? preferredPrimaryExchanges.map(x => normalizeString(x).toUpperCase()).filter(Boolean)
      : [],
  };
}

function normalizeContractResolutionConfig(cr = {}) {
  const input = cr || {};
  const cfg = {
    ...DEFAULTS.contractResolution,
    ...input,
    profiles: { ...DEFAULTS.contractResolution.profiles, ...((input && input.profiles) || {}) },
    profileBySymbol: { ...DEFAULTS.contractResolution.profileBySymbol, ...((input && input.profileBySymbol) || {}) },
  };
  const profiles = {};
  const rawProfiles = cfg.profiles && typeof cfg.profiles === 'object' && !Array.isArray(cfg.profiles) ? cfg.profiles : {};
  for (const [name, profile] of Object.entries(rawProfiles)) {
    const key = normalizeString(name).toUpperCase();
    if (!key || !profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
    profiles[key] = normalizeContractResolutionProfile(profile);
  }
  cfg.profiles = profiles;

  const profileBySymbol = {};
  const rawBySymbol = cfg.profileBySymbol && typeof cfg.profileBySymbol === 'object' && !Array.isArray(cfg.profileBySymbol)
    ? cfg.profileBySymbol
    : {};
  for (const [symbol, profileName] of Object.entries(rawBySymbol)) {
    const key = normalizeString(symbol).toUpperCase();
    const val = normalizeString(profileName).toUpperCase();
    if (key && val) profileBySymbol[key] = val;
  }
  cfg.profileBySymbol = profileBySymbol;
  cfg.defaultProfile = normalizeString(cfg.defaultProfile).toUpperCase();
  return cfg;
}

function validateConfig(input = {}) {
  const cfg = { ...DEFAULTS, ...input, contractResolution: { ...DEFAULTS.contractResolution, ...((input && input.contractResolution) || {}) } };
  const errors = [];
  if (typeof cfg.enabled !== 'boolean') errors.push('enabled must be boolean');
  if (typeof cfg.debug !== 'boolean') errors.push('debug must be boolean');
  if (!['paper', 'live'].includes(String(cfg.mode))) errors.push('mode must be "paper" or "live"');
  if (!normalizeString(cfg.host)) errors.push('host is required');
  if (!Number.isInteger(Number(cfg.port)) || Number(cfg.port) <= 0 || Number(cfg.port) > 65535) errors.push('port must be an integer from 1 to 65535');
  if (!Number.isInteger(Number(cfg.clientId)) || Number(cfg.clientId) < 0) errors.push('clientId must be a non-negative integer');
  if (!normalizeString(cfg.defaultTif)) errors.push('defaultTif is required');
  if (!Number.isInteger(Number(cfg.quoteTimeoutMs)) || Number(cfg.quoteTimeoutMs) <= 0) errors.push('quoteTimeoutMs must be a positive integer');
  if (!Number.isInteger(Number(cfg.contractResolveTimeoutMs)) || Number(cfg.contractResolveTimeoutMs) <= 0) errors.push('contractResolveTimeoutMs must be a positive integer');
  if (!Number.isInteger(Number(cfg.commissionReportTimeoutMs)) || Number(cfg.commissionReportTimeoutMs) <= 0) errors.push('commissionReportTimeoutMs must be a positive integer');
  if (typeof cfg.trackExternalExecutions !== 'boolean') errors.push('trackExternalExecutions must be boolean');
  if (!Number.isInteger(Number(cfg.marketDataType)) || Number(cfg.marketDataType) < 1) errors.push('marketDataType must be a positive integer');
  if (cfg.defaultTickSize != null && cfg.defaultTickSize !== '' && !positiveNumber(cfg.defaultTickSize)) errors.push('defaultTickSize must be a positive number when provided');
  if (typeof cfg.snapshotQuotes !== 'boolean') errors.push('snapshotQuotes must be boolean');
  if (!cfg.contractResolution || typeof cfg.contractResolution !== 'object' || Array.isArray(cfg.contractResolution)) {
    errors.push('contractResolution must be an object');
  } else {
    for (const key of ['defaultSecType', 'defaultExchange', 'defaultCurrency', 'preferredPrimaryExchanges', 'profileByInstrumentType', 'forceProfileForInstrumentTypes']) {
      if (Object.prototype.hasOwnProperty.call(cfg.contractResolution, key)) {
        errors.push(`contractResolution.${key} is no longer supported; use contractResolution.profiles instead`);
      }
    }
    if (typeof cfg.contractResolution.enabled !== 'boolean') errors.push('contractResolution.enabled must be boolean');
    if (cfg.contractResolution.profiles != null && (typeof cfg.contractResolution.profiles !== 'object' || Array.isArray(cfg.contractResolution.profiles))) {
      errors.push('contractResolution.profiles must be an object');
    }
    if (cfg.contractResolution.profileBySymbol != null && (typeof cfg.contractResolution.profileBySymbol !== 'object' || Array.isArray(cfg.contractResolution.profileBySymbol))) {
      errors.push('contractResolution.profileBySymbol must be an object');
    }
    const profiles = cfg.contractResolution.profiles && typeof cfg.contractResolution.profiles === 'object' && !Array.isArray(cfg.contractResolution.profiles)
      ? cfg.contractResolution.profiles
      : {};
    const profileNames = new Set(Object.keys(profiles).map(name => normalizeString(name).toUpperCase()).filter(Boolean));
    if (profileNames.size === 0) errors.push('contractResolution.profiles must define at least one profile');
    for (const [name, profile] of Object.entries(profiles)) {
      const profileName = normalizeString(name).toUpperCase();
      if (!profileName) errors.push('contractResolution.profiles profile names must be non-empty');
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        errors.push(`contractResolution.profiles.${name} must be an object`);
        continue;
      }
      for (const key of ['secType', 'exchange', 'currency']) {
        if (!normalizeString(profile[key])) errors.push(`contractResolution.profiles.${name}.${key} is required`);
      }
      const preferred = normalizePreferredPrimaryExchanges(profile.preferredPrimaryExchanges);
      if (!Array.isArray(preferred)) errors.push(`contractResolution.profiles.${name}.preferredPrimaryExchanges must be an array or comma-separated string`);
    }
    const defaultProfile = normalizeString(cfg.contractResolution.defaultProfile).toUpperCase();
    if (!defaultProfile) {
      errors.push('contractResolution.defaultProfile is required');
    } else if (!profileNames.has(defaultProfile)) {
      errors.push(`contractResolution.defaultProfile references unknown profile "${defaultProfile}"`);
    }
    const bySymbol = cfg.contractResolution.profileBySymbol && typeof cfg.contractResolution.profileBySymbol === 'object' && !Array.isArray(cfg.contractResolution.profileBySymbol)
      ? cfg.contractResolution.profileBySymbol
      : {};
    for (const [symbol, profileNameRaw] of Object.entries(bySymbol)) {
      const profileName = normalizeString(profileNameRaw).toUpperCase();
      if (!normalizeString(symbol)) errors.push('contractResolution.profileBySymbol symbol keys must be non-empty');
      if (!profileName) errors.push(`contractResolution.profileBySymbol.${symbol} is required`);
      else if (!profileNames.has(profileName)) errors.push(`contractResolution.profileBySymbol.${symbol} references unknown profile "${profileName}"`);
    }
  }
  if (cfg.instruments != null && (typeof cfg.instruments !== 'object' || Array.isArray(cfg.instruments))) errors.push('instruments must be an object keyed by app symbol');
  return { ok: errors.length === 0, errors, config: cfg };
}

function validateContract(symbol, contract) {
  if (!contract || typeof contract !== 'object') return `IBKR contract mapping missing for ${symbol}`;
  if (contract.conId != null && Number.isInteger(Number(contract.conId)) && Number(contract.conId) > 0) return '';
  for (const key of ['symbol', 'secType', 'exchange', 'currency']) {
    if (!normalizeString(contract[key])) return `IBKR contract for ${symbol} requires ${key} when conId is not provided`;
  }
  const secType = normalizeString(contract.secType).toUpperCase();
  const currency = normalizeString(contract.currency).toUpperCase();
  const exchange = normalizeString(contract.exchange).toUpperCase();
  if (secType === 'STK' && currency === 'USD' && exchange === 'SMART' && !normalizeString(contract.primaryExchange)) {
    return `IBKR SMART-routed US stock contract for ${symbol} requires primaryExchange to avoid ambiguity`;
  }
  return '';
}

function configuredTickSize(contract, cfg) {
  return positiveNumber(contract?.tickSize) || positiveNumber(contract?.minTick) || positiveNumber(cfg?.defaultTickSize);
}

function normalizePrimaryExchange(value) {
  return normalizeString(value).toUpperCase();
}

function primaryExchangeMatches(candidate, preferred) {
  const c = normalizePrimaryExchange(candidate);
  const p = normalizePrimaryExchange(preferred);
  if (!c || !p) return false;
  if (c === p) return true;
  return PRIMARY_EXCHANGE_ALIASES[p]?.has(c) || false;
}

function contractSupportsExchange(contract, exchange) {
  const ex = normalizeString(exchange).toUpperCase();
  if (!ex) return true;
  if (normalizeString(contract.exchange).toUpperCase() === ex) return true;
  const valid = normalizeString(contract.validExchanges).toUpperCase().split(',').map(x => x.trim()).filter(Boolean);
  return valid.includes(ex);
}

function extractContractFromDetails(details) {
  return details?.contract || details?.summary || details || {};
}

function normalizeContractDetails(details) {
  const contract = extractContractFromDetails(details);
  const out = normalizeContract(contract);
  const minTick = positiveNumber(details?.minTick ?? contract?.minTick);
  return { contract: out, tickSize: minTick, raw: safeClone(details) };
}

function normalizeContract(contract) {
  const out = {};
  for (const [key, value] of Object.entries(contract || {})) {
    if (value === undefined || value === null || value === '' || key === 'tickSize' || key === 'minTick' || key === 'validExchanges') continue;
    out[key] = key === 'conId' ? Number(value) : value;
  }
  return out;
}

function normalizeAction(side) {
  const s = normalizeString(side).toUpperCase();
  if (s === 'BUY' || s === 'SELL') return s;
  if (s === 'BUYTOCOVER') return 'BUY';
  return '';
}

function normalizeOrderType(type) {
  const t = normalizeString(type || 'market').toUpperCase();
  if (t === 'MARKET') return 'MKT';
  if (t === 'LIMIT') return 'LMT';
  if (t === 'MKT' || t === 'LMT') return t;
  return '';
}

function getClientOrderId(order = {}) {
  return normalizeString(order?.meta?.cid) || normalizeString(order.clientOrderId) || normalizeString(order.cid) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function buildAbsoluteProtection(order, action) {
  const meta = order?.meta?.ibkr || order?.ibkr || {};
  const explicitTp = positiveNumber(meta.takeProfitPrice ?? meta.tpPrice ?? order.takeProfitPrice);
  const explicitSl = positiveNumber(meta.stopLossPrice ?? meta.slPrice ?? order.stopLossPrice);
  if (explicitTp && explicitSl) return { requested: true, takeProfitPrice: explicitTp, stopLossPrice: explicitSl };

  const tpDistance = positiveNumber(order.tp);
  const slDistance = positiveNumber(order.sl);
  const requested = Boolean(tpDistance || slDistance || meta.bracket === true || meta.protective === true);
  if (!requested) return { requested: false };
  if (!tpDistance || !slDistance) return { requested: true, error: 'Both tp and sl distances are required for an IBKR bracket order' };
  const price = positiveNumber(order.price ?? meta.entryPrice);
  const tickSize = positiveNumber(order.tickSize ?? meta.tickSize);
  if (!price || !tickSize) return { requested: true, error: 'price and tickSize are required to derive IBKR bracket TP/SL prices from tp/sl distances' };
  const takeProfitPrice = action === 'BUY' ? price + tpDistance * tickSize : price - tpDistance * tickSize;
  const stopLossPrice = action === 'BUY' ? price - slDistance * tickSize : price + slDistance * tickSize;
  if (!(takeProfitPrice > 0) || !(stopLossPrice > 0)) return { requested: true, error: 'derived IBKR bracket TP/SL prices must be positive' };
  return { requested: true, takeProfitPrice, stopLossPrice };
}

function buildOrderRequests(order, contract, cfg, allocateId) {
  const action = normalizeAction(order.side || order.action);
  if (!action) throw createContextError('IBKR supports only BUY/SELL actions', { adapter: 'ibkr', symbol: order.symbol, side: order.side });
  const orderType = normalizeOrderType(order.type || order.orderType);
  if (!orderType) throw createContextError('Unsupported IBKR order type', { adapter: 'ibkr', symbol: order.symbol, orderType: order.type || order.orderType });
  const quantity = positiveNumber(order.qty ?? order.quantity);
  if (!quantity) throw createContextError('IBKR order quantity must be positive', { adapter: 'ibkr', symbol: order.symbol });
  if (orderType === 'LMT' && !positiveNumber(order.price ?? order.limitPrice)) {
    throw createContextError('IBKR limit order requires a positive limit price', { adapter: 'ibkr', symbol: order.symbol, orderType });
  }

  const parentId = allocateId();
  const tif = normalizeString(order.tif || order.timeInForce || cfg.defaultTif);
  const baseOrder = {
    orderId: parentId,
    action,
    orderType,
    totalQuantity: quantity,
    tif,
    account: cfg.accountId,
    orderRef: getClientOrderId(order),
  };
  if (orderType === 'LMT') baseOrder.lmtPrice = Number(order.price ?? order.limitPrice);

  const protection = buildAbsoluteProtection(order, action);
  if (!protection.requested) {
    return [{ orderId: parentId, contract, order: { ...baseOrder, transmit: true }, role: 'parent' }];
  }
  if (protection.error) throw createContextError(protection.error, { adapter: 'ibkr', symbol: order.symbol, contract: safeContractSummary(contract), orderType });

  const takeProfitId = allocateId();
  const stopLossId = allocateId();
  const childAction = action === 'BUY' ? 'SELL' : 'BUY';
  return [
    { orderId: parentId, contract, order: { ...baseOrder, transmit: false }, role: 'parent' },
    {
      orderId: takeProfitId,
      contract,
      role: 'takeProfit',
      order: { orderId: takeProfitId, action: childAction, orderType: 'LMT', totalQuantity: quantity, lmtPrice: protection.takeProfitPrice, parentId, tif, account: cfg.accountId, orderRef: baseOrder.orderRef, transmit: false },
    },
    {
      orderId: stopLossId,
      contract,
      role: 'stopLoss',
      order: { orderId: stopLossId, action: childAction, orderType: 'STP', totalQuantity: quantity, auxPrice: protection.stopLossPrice, parentId, tif, account: cfg.accountId, orderRef: baseOrder.orderRef, transmit: true },
    },
  ];
}

function loadStoqeyClientFactory() {
  // Optional runtime dependency. Kept lazy so the disabled adapter and tests cannot trade accidentally.
  // Selected because @stoqey/ib implements the TWS/IB Gateway socket protocol directly in Node.
  // IBKR does not officially support third-party Node packages; operators must install and validate it.
  const mod = require('@stoqey/ib');
  const EventName = mod.EventName || {};
  return {
    eventNames: {
      error: EventName.error || 'error',
      nextValidId: EventName.nextValidId || 'nextValidId',
      managedAccounts: EventName.managedAccounts || 'managedAccounts',
      openOrder: EventName.openOrder || 'openOrder',
      orderStatus: EventName.orderStatus || 'orderStatus',
      execDetails: EventName.execDetails || 'execDetails',
      execDetailsEnd: EventName.execDetailsEnd || 'execDetailsEnd',
      commissionReport: EventName.commissionReport || 'commissionReport',
      position: EventName.position || 'position',
      positionEnd: EventName.positionEnd || 'positionEnd',
      contractDetails: EventName.contractDetails || 'contractDetails',
      contractDetailsEnd: EventName.contractDetailsEnd || 'contractDetailsEnd',
      tickPrice: EventName.tickPrice || 'tickPrice',
      tickSize: EventName.tickSize || 'tickSize',
      tickSnapshotEnd: EventName.tickSnapshotEnd || 'tickSnapshotEnd',
      marketDataType: EventName.marketDataType || 'marketDataType',
      rerouteMktDataReq: EventName.rerouteMktDataReq || 'rerouteMktDataReq',
      tickReqParams: EventName.tickReqParams || 'tickReqParams',
      tickString: EventName.tickString || 'tickString',
      tickGeneric: EventName.tickGeneric || 'tickGeneric',
      tickOptionComputation: EventName.tickOptionComputation || 'tickOptionComputation',
      connectionClosed: EventName.connectionClosed || 'connectionClosed',
    },
    create(config) {
      return new mod.IBApi({ host: config.host, port: Number(config.port), clientId: Number(config.clientId) });
    },
  };
}

class IBKRAdapter extends ExecutionAdapter {
  constructor(cfg = {}, providerName = 'ibkr') {
    super();
    this.provider = providerName;
    const validation = validateConfig(cfg);
    if (!validation.ok) throw new Error(`IBKR config invalid: ${validation.errors.join('; ')}`);
    this.cfg = validation.config;
    this.cfg.port = Number(this.cfg.port);
    this.cfg.clientId = Number(this.cfg.clientId);
    this.cfg.accountId = normalizeString(this.cfg.accountId);
    this.cfg.defaultTif = normalizeString(this.cfg.defaultTif).toUpperCase();
    this.cfg.quoteTimeoutMs = Number(this.cfg.quoteTimeoutMs);
    this.cfg.contractResolveTimeoutMs = Number(this.cfg.contractResolveTimeoutMs);
    this.cfg.commissionReportTimeoutMs = Number(this.cfg.commissionReportTimeoutMs);
    this.cfg.marketDataType = Number(this.cfg.marketDataType);
    this.cfg.defaultTickSize = this.cfg.defaultTickSize == null || this.cfg.defaultTickSize === '' ? null : Number(this.cfg.defaultTickSize);
    this.cfg.contractResolution = normalizeContractResolutionConfig(this.cfg.contractResolution);
    this.cfg.instruments = this.cfg.instruments || {};
    this.events = new EventEmitter();
    this.client = null;
    this.eventNames = null;
    this.connected = false;
    this.managedAccounts = [];
    this.selectedAccount = '';
    this.nextOrderId = null;
    this.maxObservedOrderId = 0;
    this.pending = new Map();
    this.cancels = new Map();
    this.orderStatus = new Map();
    this.logicalPositions = new Map();
    this.logicalPositionsByCid = new Map();
    this.orderIdToLogical = new Map();
    this.executionsByFamily = new Map();
    this.commissionReportsByExecId = new Map();
    this.currentPositions = new Map();
    this.positionsInitialized = false;
    this.lifecycleStreamsStarted = false;
    this.sessionExecutionStart = ibkrExecutionTime();
    this.nextExecutionReqId = Number.isInteger(Number(this.cfg.executionReqIdStart)) ? Number(this.cfg.executionReqIdStart) : 700000000;
    this.executionReconcileTimer = null;
    this.quoteRequests = new Map();
    this.quoteRequestsBySymbol = new Map();
    this.contractRequests = new Map();
    this.resolvedContracts = new Map();
    this.nextQuoteReqId = Number.isInteger(Number(this.cfg.quoteReqIdStart)) ? Number(this.cfg.quoteReqIdStart) : 900000000;
    this.nextQuoteWaiterId = 1;
    this.nextContractReqId = Number.isInteger(Number(this.cfg.contractReqIdStart)) ? Number(this.cfg.contractReqIdStart) : 800000000;
    this.logs = [];

    if (this.cfg.trackExternalExecutions && Number(this.cfg.clientId) !== 0) {
      this.#log('error', 'external execution tracking may be incomplete unless this connection uses TWS Master API client ID 0', { provider: this.provider, clientId: this.cfg.clientId });
    }

    if (this.cfg.enabled && this.cfg.autoConnect !== false) this.connect().catch(err => this.#log('error', 'connect failed', { error: err.message }));
  }

  on(event, fn) { this.events.on(event, fn); return () => this.events.off(event, fn); }

  #log(level, message, context = {}) {
    const safeContext = safeClone(context);
    if (Object.prototype.hasOwnProperty.call(safeContext, 'message')) {
      safeContext.detail = safeContext.message;
      delete safeContext.message;
    }
    if (Object.prototype.hasOwnProperty.call(safeContext, 'level')) {
      safeContext.contextLevel = safeContext.level;
      delete safeContext.level;
    }
    const entry = { level, message, ...safeContext };
    this.logs.push(entry);
    if (this.cfg.debug !== true) return;
    const logger = level === 'error' ? console.error : console.log;
    logger('[IBKR]', entry);
  }

  async connect() {
    if (!this.cfg.enabled) return { status: 'disabled', provider: this.provider };
    if (!this.client) {
      const factory = this.cfg.clientFactory || loadStoqeyClientFactory();
      this.eventNames = factory.eventNames || {};
      this.client = factory.create(this.cfg);
      this.#wireClient();
    }
    this.#log('info', 'connecting', { provider: this.provider, mode: this.cfg.mode, host: this.cfg.host, port: this.cfg.port, clientId: this.cfg.clientId });
    if (typeof this.client.connect === 'function') this.client.connect();
    if (typeof this.client.reqManagedAccts === 'function') this.client.reqManagedAccts();
    if (typeof this.client.reqIds === 'function') this.client.reqIds(-1);
    if (typeof this.client.reqOpenOrders === 'function') this.client.reqOpenOrders();
    return { status: 'connecting', provider: this.provider };
  }

  disconnect() {
    if (this.client && typeof this.client.disconnect === 'function') this.client.disconnect();
    this.connected = false;
  }

  isReady() {
    return Boolean(this.cfg.enabled && this.connected && this.selectedAccount && Number.isInteger(this.nextOrderId));
  }

  readinessReason() {
    if (!this.cfg.enabled) return 'IBKR adapter is disabled';
    if (!this.connected) return 'IB Gateway/TWS is not connected or API access is not ready';
    if (!this.selectedAccount) return 'IBKR account is not selected from managed accounts';
    if (!Number.isInteger(this.nextOrderId)) return 'IBKR nextValidId has not been received';
    return '';
  }

  #eventName(name) { return this.eventNames?.[name] || name; }

  #wireClient() {
    const on = (name, handler) => {
      if (this.client && typeof this.client.on === 'function') this.client.on(this.#eventName(name), handler);
    };
    on('nextValidId', orderId => this.#handleNextValidId(orderId));
    on('managedAccounts', accounts => this.#handleManagedAccounts(accounts));
    on('openOrder', (orderId, contract, order, orderState) => this.#handleOpenOrder(orderId, contract, order, orderState));
    on('orderStatus', (orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld) => this.#handleOrderStatus(orderId, status, { filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld }));
    on('execDetails', (reqId, contract, execution) => this.#handleExecDetails(reqId, contract, execution));
    on('execDetailsEnd', reqId => this.#handleExecDetailsEnd(reqId));
    on('commissionReport', report => this.#handleCommissionReport(report));
    on('position', (account, contract, pos, avgCost) => this.#handlePosition(account, contract, pos, avgCost));
    on('positionEnd', () => this.#handlePositionEnd());
    on('contractDetails', (reqId, details) => this.#handleContractDetails(reqId, details));
    on('contractDetailsEnd', reqId => this.#handleContractDetailsEnd(reqId));
    on('tickPrice', (reqId, tickType, price, attribs) => this.#handleTickPrice(reqId, tickType, price, attribs));
    on('tickSize', (reqId, tickType, size) => this.#handleTickSize(reqId, tickType, size));
    on('tickSnapshotEnd', reqId => this.#handleTickSnapshotEnd(reqId));
    on('marketDataType', (reqId, marketDataType) => this.#handleMarketDataType(reqId, marketDataType));
    on('rerouteMktDataReq', (reqId, conId, exchange) => this.#handleRerouteMktDataReq(reqId, conId, exchange));
    on('tickReqParams', (reqId, minTick, bboExchange, snapshotPermissions) => this.#handleTickReqParams(reqId, minTick, bboExchange, snapshotPermissions));
    on('tickString', (reqId, tickType, value) => this.#handleQuoteDiagnosticEvent(reqId, 'tickString', { tickType: Number(tickType), value }));
    on('tickGeneric', (reqId, tickType, value) => this.#handleQuoteDiagnosticEvent(reqId, 'tickGeneric', { tickType: Number(tickType), value: finiteNumber(value) }));
    on('tickOptionComputation', (reqId, tickType, tickAttrib, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice) => this.#handleQuoteDiagnosticEvent(reqId, 'tickOptionComputation', {
      tickType: Number(tickType),
      tickAttrib: safeClone(tickAttrib),
      impliedVol: finiteNumber(impliedVol),
      delta: finiteNumber(delta),
      optPrice: finiteNumber(optPrice),
      pvDividend: finiteNumber(pvDividend),
      gamma: finiteNumber(gamma),
      vega: finiteNumber(vega),
      theta: finiteNumber(theta),
      undPrice: finiteNumber(undPrice),
    }));
    on('connectionClosed', () => this.#handleDisconnected('connectionClosed'));
    on('error', (err, code, reqId) => this.#handleIbError(err, code, reqId));
    if (typeof this.client.once === 'function') {
      this.client.once('connect', () => { this.connected = true; this.#log('info', 'socket connected', { provider: this.provider }); });
    }
  }

  #handleNextValidId(orderId) {
    const id = Number(orderId);
    if (!Number.isInteger(id) || id < 0) return;
    this.connected = true;
    this.nextOrderId = Math.max(id, this.maxObservedOrderId + 1);
    this.#log('info', 'nextValidId received', { provider: this.provider, nextOrderId: this.nextOrderId, maxObservedOrderId: this.maxObservedOrderId });
    this.#maybeStartLifecycleStreams();
  }

  #handleManagedAccounts(accounts) {
    const list = Array.isArray(accounts) ? accounts : String(accounts || '').split(',');
    this.managedAccounts = list.map(normalizeString).filter(Boolean);
    if (this.cfg.accountId) {
      this.selectedAccount = this.managedAccounts.includes(this.cfg.accountId) ? this.cfg.accountId : '';
    } else if (this.managedAccounts.length === 1) {
      this.selectedAccount = this.managedAccounts[0];
      this.cfg.accountId = this.selectedAccount;
    } else {
      this.selectedAccount = '';
    }
    this.connected = true;
    this.#log(this.selectedAccount ? 'info' : 'error', 'managed accounts received', { provider: this.provider, selectedAccount: this.selectedAccount || '(none)', accountCount: this.managedAccounts.length });
    this.#maybeStartLifecycleStreams();
  }

  #observeOrderId(orderId) {
    const id = Number(orderId);
    if (!Number.isInteger(id) || id < 0) return;
    this.maxObservedOrderId = Math.max(this.maxObservedOrderId, id);
    if (Number.isInteger(this.nextOrderId) && this.nextOrderId <= this.maxObservedOrderId) this.nextOrderId = this.maxObservedOrderId + 1;
  }

  #handleOpenOrder(orderId, contract, order, orderState) {
    this.#observeOrderId(orderId);
    this.#log('info', 'openOrder', { provider: this.provider, orderId, status: orderState?.status, symbol: contract?.symbol, contract: safeContractSummary(contract) });
  }

  #handleOrderStatus(orderId, status, details = {}) {
    this.#observeOrderId(orderId);
    const s = normalizeString(status);
    this.orderStatus.set(String(orderId), { status: s, ...details });
    this.#log('info', 'orderStatus', { provider: this.provider, orderId, status: s, remaining: details.remaining, filled: details.filled });

    const pending = this.pending.get(String(orderId));
    if (pending) {
      if (ACCEPTED_STATUSES.has(s)) this.#confirmPending(String(orderId), orderId, { status: s, details });
      if (REJECTED_STATUSES.has(s)) this.#rejectPending(String(orderId), `IBKR order ${s}`, { status: s, details });
    }

    const cancel = this.cancels.get(String(orderId));
    if (cancel && FINAL_CANCEL_STATUSES.has(s)) {
      clearTimeout(cancel.timer);
      this.cancels.delete(String(orderId));
      this.events.emit('order:cancelled', { ticket: String(orderId) });
      cancel.resolve({ status: 'ok', provider: this.provider, providerOrderId: String(orderId), raw: { status: s } });
    }
  }

  #positionKey(account, contract) {
    return `${normalizeString(account)}|${contractIdentity(contract)}`;
  }

  #maybeStartLifecycleStreams() {
    if (!this.connected || !this.selectedAccount || !Number.isInteger(this.nextOrderId) || this.lifecycleStreamsStarted) return;
    this.lifecycleStreamsStarted = true;
    if (typeof this.client?.reqPositions === 'function') {
      try {
        this.client.reqPositions();
      } catch (err) {
        this.#log('error', 'reqPositions failed', { provider: this.provider, reason: err?.message || String(err) });
      }
    }
    this.#scheduleExecutionReconciliation();
  }

  #scheduleExecutionReconciliation() {
    if (typeof this.client?.reqExecutions !== 'function' || !this.selectedAccount) return;
    if (this.executionReconcileTimer) return;
    this.executionReconcileTimer = setTimeout(() => {
      this.executionReconcileTimer = null;
      const reqId = this.nextExecutionReqId++;
      try {
        this.client.reqExecutions(reqId, { acctCode: this.selectedAccount, time: this.sessionExecutionStart });
        this.#log('info', 'execution reconciliation requested', { provider: this.provider, reqId, account: this.selectedAccount });
      } catch (err) {
        this.#log('error', 'reqExecutions failed', { provider: this.provider, reqId, reason: err?.message || String(err) });
      }
    }, 25);
    if (typeof this.executionReconcileTimer.unref === 'function') this.executionReconcileTimer.unref();
  }

  #handleExecDetailsEnd(reqId) {
    this.#log('info', 'execution reconciliation completed', { provider: this.provider, reqId });
  }

  #handlePosition(account, contract, pos, avgCost) {
    if (this.selectedAccount && normalizeString(account) !== this.selectedAccount) return;
    const key = this.#positionKey(account, contract);
    const previous = this.currentPositions.get(key);
    const quantity = finiteNumber(pos) ?? 0;
    this.currentPositions.set(key, { quantity, avgCost: finiteNumber(avgCost), contract: safeClone(contract), account: normalizeString(account) });
    if (this.positionsInitialized && previous && previous.quantity !== quantity) {
      const tracked = Array.from(this.logicalPositions.values()).some(logical => logical.positionKey === key && logical.entryFilled > logical.exitFilled);
      if (tracked) this.#scheduleExecutionReconciliation();
    }
  }

  #handlePositionEnd() {
    if (!this.positionsInitialized) {
      this.positionsInitialized = true;
      for (const logical of this.logicalPositions.values()) {
        if (logical.baselineKnown || logical.entryFilled > 0) continue;
        const baselineQty = this.currentPositions.get(logical.positionKey)?.quantity || 0;
        logical.baselineKnown = true;
        logical.baselineQty = baselineQty;
        logical.externalInferenceSafe = Math.abs(baselineQty) < 1e-9;
      }
    }
    this.#scheduleExecutionReconciliation();
  }

  #remainingQuantity(logical) {
    return Math.max(0, Number(logical.entryFilled || 0) - Number(logical.exitFilled || 0));
  }

  #findLogicalForExecution(contract, execution) {
    const orderId = normalizeString(execution?.orderId);
    const known = this.orderIdToLogical.get(orderId);
    if (known) return { ...known, source: 'order-id' };

    const cid = normalizeString(execution?.orderRef);
    const byCid = cid ? this.logicalPositionsByCid.get(cid) : null;
    const side = normalizeExecutionSide(execution?.side);
    if (byCid) {
      return { logical: byCid, role: side === byCid.entryAction ? 'parent' : 'externalExit', source: 'order-ref' };
    }

    if (!this.cfg.trackExternalExecutions || !side) return null;
    const account = normalizeString(execution?.acctNumber);
    const identity = contractIdentity(contract);
    const shares = positiveNumber(execution?.shares);
    if (!shares) return null;
    const related = Array.from(this.logicalPositions.values()).filter(logical => {
      const remaining = this.#remainingQuantity(logical);
      return logical.confirmed
        && remaining > 1e-9
        && logical.account === account
        && logical.contractIdentity === identity
        && side !== logical.entryAction
        && shares <= remaining + 1e-9;
    });
    const candidates = related.filter(logical => logical.externalInferenceSafe);
    if (related.length !== 1) {
      if (related.length) this.#log('info', 'external execution not attributed', { provider: this.provider, execId: execution?.execId, symbol: contract?.symbol, candidates: related.length, reason: 'ambiguous' });
      return null;
    }
    if (candidates.length !== 1) {
      const potentiallyRelated = Array.from(this.logicalPositions.values()).some(logical => logical.account === account && logical.contractIdentity === identity && this.#remainingQuantity(logical) > 1e-9);
      if (potentiallyRelated) this.#log('info', 'external execution not attributed', { provider: this.provider, execId: execution?.execId, symbol: contract?.symbol, candidates: candidates.length, reason: candidates.length ? 'ambiguous' : 'no-safe-match' });
      return null;
    }
    this.#log('info', 'external execution attributed to tracked position', { provider: this.provider, execId: execution?.execId, parentOrderId: candidates[0].parentId, symbol: contract?.symbol });
    return { logical: candidates[0], role: 'externalExit', source: 'inferred' };
  }

  #reverseExecutionRecord(record) {
    const logical = record?.logical;
    if (!logical) return;
    if (record.kind === 'entry') {
      logical.entryFilled = Math.max(0, logical.entryFilled - record.appliedShares);
    } else if (record.kind === 'exit') {
      logical.exitFilled = Math.max(0, logical.exitFilled - record.appliedShares);
      logical.closingExecutionFamilies.delete(record.family);
      logical.pnlByExecutionFamily.delete(record.family);
    }
  }

  #handleExecDetails(reqId, contract, execution = {}) {
    const execId = normalizeString(execution.execId);
    if (!execId) {
      this.#log('error', 'execution details missing execId', { provider: this.provider, reqId, orderId: execution.orderId, symbol: contract?.symbol });
      return;
    }
    const family = executionFamily(execId);
    const existing = this.executionsByFamily.get(family);
    if (existing?.execId === execId) return;
    if (existing && executionRevision(execId) < executionRevision(existing.execId)) return;
    if (existing) this.#reverseExecutionRecord(existing);

    const match = this.#findLogicalForExecution(contract, execution);
    const shares = positiveNumber(execution.shares);
    const record = {
      family,
      execId,
      execution: safeClone(execution),
      contract: safeClone(contract),
      logical: match?.logical || null,
      role: match?.role,
      kind: null,
      appliedShares: 0,
    };
    this.executionsByFamily.set(family, record);
    this.#log('info', 'execution details', { provider: this.provider, reqId, execId, orderId: execution.orderId, symbol: contract?.symbol, role: match?.role, source: match?.source });
    if (!match || !shares) return;

    const logical = match.logical;
    if (match.role === 'parent') {
      record.kind = 'entry';
      record.appliedShares = shares;
      logical.entryFilled += shares;
      if (logical.confirmed) this.#emitPositionOpened(logical, execution, contract);
    } else {
      const remaining = this.#remainingQuantity(logical);
      if (remaining <= 1e-9) return;
      record.kind = 'exit';
      record.appliedShares = Math.min(shares, remaining);
      logical.exitFilled += record.appliedShares;
      logical.closingExecutionFamilies.add(family);
      const report = this.commissionReportsByExecId.get(execId);
      const profit = finiteRealizedPnl(report?.realizedPNL);
      if (profit != null) logical.pnlByExecutionFamily.set(family, profit);
      this.#tryFinalizeLogicalPosition(logical);
    }
  }

  #emitPositionOpened(logical, execution, contract) {
    if (logical.openedEmitted || logical.entryFilled <= 0) return;
    logical.openedEmitted = true;
    this.events.emit('position:opened', {
      ticket: logical.parentId,
      order: { symbol: contract?.symbol || logical.origOrder?.symbol, size: logical.entryFilled, execution: safeClone(execution), clientOrderId: logical.cid },
      origOrder: logical.origOrder,
    });
  }

  #handleCommissionReport(report = {}) {
    const execId = normalizeString(report.execId);
    if (!execId) return;
    this.commissionReportsByExecId.set(execId, safeClone(report));
    const family = executionFamily(execId);
    const record = this.executionsByFamily.get(family);
    if (!record || record.execId !== execId || record.kind !== 'exit' || !record.logical) return;
    const profit = finiteRealizedPnl(report.realizedPNL);
    if (profit == null) record.logical.pnlByExecutionFamily.delete(family);
    else record.logical.pnlByExecutionFamily.set(family, profit);
    this.#tryFinalizeLogicalPosition(record.logical);
  }

  #tryFinalizeLogicalPosition(logical) {
    if (!logical.confirmed || logical.entryFilled <= 0 || this.#remainingQuantity(logical) > 1e-9) return;
    const families = Array.from(logical.closingExecutionFamilies);
    const complete = families.length > 0 && families.every(family => logical.pnlByExecutionFamily.has(family));
    if (complete) {
      if (logical.closeTimer) clearTimeout(logical.closeTimer);
      logical.closeTimer = null;
      const profit = families.reduce((sum, family) => sum + logical.pnlByExecutionFamily.get(family), 0);
      if (!logical.reportedEmitted || logical.lastEmittedProfit !== profit) {
        logical.reportedEmitted = true;
        logical.lastEmittedProfit = profit;
        this.events.emit('position:closed', { ticket: logical.parentId, trade: { profit, pnlStatus: 'reported' } });
      }
      return;
    }
    if (logical.closeTimer) return;
    logical.closeTimer = setTimeout(() => {
      logical.closeTimer = null;
      const nowComplete = Array.from(logical.closingExecutionFamilies).every(family => logical.pnlByExecutionFamily.has(family));
      if (nowComplete) {
        this.#tryFinalizeLogicalPosition(logical);
        return;
      }
      if (!logical.unavailableEmitted || logical.reportedEmitted) {
        logical.unavailableEmitted = true;
        logical.reportedEmitted = false;
        logical.lastEmittedProfit = undefined;
        this.events.emit('position:closed', { ticket: logical.parentId, trade: { pnlStatus: 'unavailable' } });
      }
    }, this.cfg.commissionReportTimeoutMs);
    if (typeof logical.closeTimer.unref === 'function') logical.closeTimer.unref();
  }

  #handleDisconnected(reason) {
    this.connected = false;
    this.nextOrderId = null;
    this.lifecycleStreamsStarted = false;
    this.#log('error', 'disconnected', { provider: this.provider, reason });
  }

  #handleIbError(err, code, reqId) {
    const message = err?.message || String(err || 'IBKR API error');
    const mapped = createContextError('IBKR API error', { adapter: 'ibkr', code, reqId, message });
    this.#log('error', 'api error', { provider: this.provider, code, reqId, message: mapped.message });
    const key = String(reqId);
    if (this.quoteRequests.has(key)) {
      const isPermission = MARKET_DATA_PERMISSION_CODES.has(Number(code));
      const rec = this.quoteRequests.get(key);
      this.#appendQuoteDiagnosticSample(rec, 'errors', { code: Number(code), label: MARKET_DATA_DIAGNOSTIC_ERROR_LABELS[Number(code)] || 'market-data-error', message });
      this.#log('error', isPermission ? 'IBKR market data subscription missing or unavailable' : 'market data error', this.#quoteDiagnosticContext(rec, { reqId: Number(reqId), code, errorLabel: MARKET_DATA_DIAGNOSTIC_ERROR_LABELS[Number(code)] || 'market-data-error', errorMessage: message }));
      this.#resolveQuote(key, null, isPermission ? 'permission-error' : 'error');
    }
    if (this.contractRequests.has(key)) {
      this.#resolveContract(key, null, `IBKR contract resolution failed for ${this.contractRequests.get(key).symbol}: ${message}`);
    }
    if (this.pending.has(key)) this.#rejectPending(key, mapped.message, { code, reqId });
  }

  #allocateQuoteReqId() {
    return this.nextQuoteReqId++;
  }

  #allocateContractReqId() {
    return this.nextContractReqId++;
  }

  #selectContractResolutionProfile(symbol) {
    const cr = this.cfg.contractResolution;
    const key = normalizeString(symbol).toUpperCase();
    const profileName = normalizeString(cr.profileBySymbol?.[key]).toUpperCase() || cr.defaultProfile;

    const profile = cr.profiles[profileName];
    return {
      name: profileName,
      cacheKey: `${profileName}:${profile.secType}:${profile.exchange}:${profile.currency}:${(profile.preferredPrimaryExchanges || []).join(',')}`,
      ...profile,
    };
  }

  #contractCacheKey(symbol, profile) {
    return `${normalizeString(symbol).toUpperCase()}|${profile?.cacheKey || 'STATIC'}`;
  }

  #buildDefaultContractRequest(symbol, profile) {
    return {
      symbol,
      secType: profile.secType,
      exchange: profile.exchange,
      currency: profile.currency,
    };
  }

  #candidateSummaries(candidates) {
    return candidates.map(c => safeContractSummary(c.contract || c));
  }

  #selectResolvedContract(symbol, candidates, profile) {
    const normalized = candidates.map(normalizeContractDetails).filter(c => Object.keys(c.contract).length);
    let plausible = normalized.filter(c => positiveNumber(c.contract.conId));
    plausible = plausible.filter(c => normalizeString(c.contract.secType).toUpperCase() === profile.secType);
    plausible = plausible.filter(c => normalizeString(c.contract.currency).toUpperCase() === profile.currency);
    plausible = plausible.filter(c => contractSupportsExchange({ ...c.contract, validExchanges: extractContractFromDetails(c.raw).validExchanges || c.raw?.validExchanges }, profile.exchange));

    if (plausible.length === 0) {
      throw createContextError(`IBKR could not resolve contract for ${symbol}`, { adapter: 'ibkr', symbol, candidates: this.#candidateSummaries(normalized) });
    }

    const preferred = profile.preferredPrimaryExchanges || [];
    for (const pref of preferred) {
      const matching = plausible.filter(c => primaryExchangeMatches(c.contract.primaryExchange, pref));
      if (matching.length === 1) return matching[0];
      if (matching.length > 1) {
        throw createContextError(`IBKR contract resolution ambiguous for ${symbol}`, { adapter: 'ibkr', symbol, candidates: this.#candidateSummaries(matching) });
      }
    }

    if (plausible.length === 1) return plausible[0];
    throw createContextError(`IBKR contract resolution ambiguous for ${symbol}`, { adapter: 'ibkr', symbol, candidates: this.#candidateSummaries(plausible) });
  }

  #handleContractDetails(reqId, details) {
    const rec = this.contractRequests.get(String(reqId));
    if (!rec) return;
    rec.candidates.push(details);
  }

  #handleContractDetailsEnd(reqId) {
    const key = String(reqId);
    const rec = this.contractRequests.get(key);
    if (!rec) return;
    try {
      const selected = this.#selectResolvedContract(rec.symbol, rec.candidates, rec.profile);
      this.#resolveContract(key, selected);
    } catch (err) {
      this.#resolveContract(key, null, err.message, err.context);
    }
  }

  #resolveContract(reqId, selected, error, context) {
    const key = String(reqId);
    const rec = this.contractRequests.get(key);
    if (!rec) return;
    clearTimeout(rec.timer);
    this.contractRequests.delete(key);
    if (selected) {
      const record = { contract: selected.contract, tickSize: selected.tickSize || positiveNumber(this.cfg.defaultTickSize), source: 'resolved', profile: rec.profile, cacheKey: rec.cacheKey };
      this.resolvedContracts.set(rec.cacheKey, record);
      this.#log('info', 'IBKR contract resolved', { provider: this.provider, reqId: Number(key), symbol: rec.symbol, profile: rec.profile?.name, contract: safeContractSummary(record.contract), tickSize: record.tickSize });
      rec.resolve(record);
    } else {
      const message = error || `IBKR could not resolve contract for ${rec.symbol}`;
      this.#log('error', 'IBKR contract resolution failed', { provider: this.provider, reqId: Number(key), symbol: rec.symbol, reason: message, ...(context ? { context: safeClone(context) } : {}) });
      rec.reject(createContextError(message, context || { adapter: 'ibkr', symbol: rec.symbol }));
    }
  }


  #selectQuotePrice(quote) {
    if (positiveNumber(quote.bid) && positiveNumber(quote.ask)) return (Number(quote.bid) + Number(quote.ask)) / 2;
    if (positiveNumber(quote.last)) return Number(quote.last);
    if (positiveNumber(quote.close)) return Number(quote.close);
    return null;
  }

  #normalizedQuote(rec) {
    const price = this.#selectQuotePrice(rec.quote);
    if (!positiveNumber(price)) return null;
    const out = {
      bid: rec.quote.bid,
      ask: rec.quote.ask,
      last: rec.quote.last,
      close: rec.quote.close,
      price,
      tickSize: rec.tickSize,
      tickSource: 'ibkr',
      raw: safeClone(rec.raw),
    };
    for (const key of ['bid', 'ask', 'last', 'close', 'tickSize']) {
      if (out[key] == null) delete out[key];
    }
    return out;
  }

  #appendQuoteDiagnosticSample(rec, key, sample) {
    if (!rec?.raw || !key) return;
    if (!Array.isArray(rec.raw[key])) rec.raw[key] = [];
    rec.raw[key].push(safeClone(sample));
    if (rec.raw[key].length > QUOTE_DIAGNOSTIC_SAMPLE_LIMIT) rec.raw[key].shift();
  }

  #quoteDiagnosticCounts(rec) {
    const raw = rec?.raw || {};
    return {
      tickPrice: Array.isArray(raw.tickPrice) ? raw.tickPrice.length : 0,
      tickSize: Array.isArray(raw.tickSize) ? raw.tickSize.length : 0,
      marketDataType: Array.isArray(raw.marketDataType) ? raw.marketDataType.length : 0,
      rerouteMktDataReq: Array.isArray(raw.rerouteMktDataReq) ? raw.rerouteMktDataReq.length : 0,
      tickReqParams: Array.isArray(raw.tickReqParams) ? raw.tickReqParams.length : 0,
      tickString: Array.isArray(raw.tickString) ? raw.tickString.length : 0,
      tickGeneric: Array.isArray(raw.tickGeneric) ? raw.tickGeneric.length : 0,
      tickOptionComputation: Array.isArray(raw.tickOptionComputation) ? raw.tickOptionComputation.length : 0,
      errors: Array.isArray(raw.errors) ? raw.errors.length : 0,
    };
  }

  #quoteDiagnosticSamples(rec) {
    const raw = rec?.raw || {};
    const samples = {};
    for (const key of ['tickPrice', 'tickSize', 'marketDataType', 'rerouteMktDataReq', 'tickReqParams', 'tickString', 'tickGeneric', 'tickOptionComputation', 'errors']) {
      if (Array.isArray(raw[key]) && raw[key].length) samples[key] = safeClone(raw[key].slice(-QUOTE_DIAGNOSTIC_SAMPLE_LIMIT));
    }
    return samples;
  }

  #quoteDiagnosticContext(rec, extra = {}) {
    const startedAt = Number(rec?.startedAt);
    const elapsedMs = Number.isFinite(startedAt) ? Date.now() - startedAt : undefined;
    const context = {
      provider: this.provider,
      reqId: Number(rec?.reqId ?? extra.reqId),
      symbol: rec?.symbol,
      profile: rec?.profile,
      contract: safeContractSummary(rec?.contract),
      activeMarketDataContract: rec?.activeMarketDataContract ? safeContractSummary(rec.activeMarketDataContract) : undefined,
      secType: normalizeString(rec?.contract?.secType).toUpperCase() || undefined,
      conId: rec?.contract?.conId,
      requestedMarketDataType: rec?.raw?.marketDataTypeRequested,
      observedMarketDataType: rec?.raw?.observedMarketDataType,
      snapshotQuotes: rec?.raw?.snapshot,
      elapsedMs,
      waiterCount: Array.isArray(rec?.waiters) ? rec.waiters.length : 0,
      diagnosticCounts: this.#quoteDiagnosticCounts(rec),
      diagnosticSamples: this.#quoteDiagnosticSamples(rec),
      ...extra,
    };
    for (const key of Object.keys(context)) {
      if (context[key] === undefined || context[key] === null || context[key] === '') delete context[key];
    }
    if (context.diagnosticSamples && Object.keys(context.diagnosticSamples).length === 0) delete context.diagnosticSamples;
    return context;
  }

  #buildReroutedMarketDataContract(rec, reroute) {
    const conId = Number(reroute?.conId);
    if (!Number.isInteger(conId) || conId <= 0) return null;
    const exchange = normalizeString(reroute?.exchange) || normalizeString(rec?.contract?.exchange) || 'SMART';
    return normalizeContract({
      conId,
      symbol: rec?.contract?.symbol || rec?.symbol,
      secType: normalizeString(rec?.contract?.secType).toUpperCase() === 'CFD' ? 'STK' : rec?.contract?.secType,
      exchange,
      currency: rec?.contract?.currency,
      primaryExchange: exchange === 'SMART' ? rec?.contract?.primaryExchange : exchange,
    });
  }

  #cancelQuoteRequest(reqId) {
    if (!this.client || typeof this.client.cancelMktData !== 'function') return;
    try {
      this.client.cancelMktData(Number(reqId));
    } catch (err) {
      this.#log('error', 'cancel market data failed', { provider: this.provider, reqId, message: err?.message || String(err) });
    }
  }

  #resolveQuote(reqId, quote, reason) {
    const key = String(reqId);
    const rec = this.quoteRequests.get(key);
    if (!rec) return;
    if (quote) {
      const waiters = rec.waiters || [];
      if (!waiters.length) return;
      this.#log('info', 'quote resolved', this.#quoteDiagnosticContext(rec, { price: quote.price, bid: quote.bid, ask: quote.ask, last: quote.last, close: quote.close, tickSize: quote.tickSize }));
      rec.waiters = [];
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(quote);
      }
    } else {
      this.#closeQuoteStream(key, reason);
    }
  }

  #closeQuoteStream(reqId, reason = 'closed', { cancel = true, resolveWaiters = true } = {}) {
    const key = String(reqId);
    const rec = this.quoteRequests.get(key);
    if (!rec) return;
    this.quoteRequests.delete(key);
    if (this.quoteRequestsBySymbol.get(rec.quoteKey) === key) this.quoteRequestsBySymbol.delete(rec.quoteKey);
    if (cancel) this.#cancelQuoteRequest(key);
    if (resolveWaiters) {
      for (const waiter of rec.waiters || []) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      rec.waiters = [];
    }
    this.#log(reason === 'timeout' ? 'error' : 'error', reason === 'timeout' ? 'quote timeout' : 'quote unavailable', this.#quoteDiagnosticContext(rec, { reason }));
  }

  #waitForQuote(reqId) {
    const key = String(reqId);
    const rec = this.quoteRequests.get(key);
    if (!rec) return Promise.resolve(null);
    const quote = this.#normalizedQuote(rec);
    if (quote) return Promise.resolve(quote);
    return new Promise(resolve => {
      const waiter = { id: this.nextQuoteWaiterId++, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const live = this.quoteRequests.get(key);
        if (!live) {
          resolve(null);
          return;
        }
        const waiterCountBefore = Array.isArray(live.waiters) ? live.waiters.length : 0;
        live.waiters = (live.waiters || []).filter(w => w !== waiter);
        this.#log('error', 'quote timeout', this.#quoteDiagnosticContext(live, { reason: 'timeout', waiterId: waiter.id, waiterCount: waiterCountBefore, remainingWaiterCount: live.waiters.length }));
        resolve(null);
      }, this.cfg.quoteTimeoutMs);
      rec.waiters.push(waiter);
    });
  }

  #startQuoteStream(reqId, rec) {
    const key = String(reqId);
    this.quoteRequests.set(key, rec);
    this.quoteRequestsBySymbol.set(rec.quoteKey, key);
    try {
      rec.activeMarketDataContract = rec.contract;
      this.client.reqMktData(reqId, rec.activeMarketDataContract, '', this.cfg.snapshotQuotes === true, false, []);
    } catch (err) {
      this.#log('error', 'reqMktData failed', { provider: this.provider, reqId, symbol: rec.symbol, message: err?.message || String(err) });
      this.#closeQuoteStream(key, 'request-error');
    }
  }

  #handleTickPrice(reqId, tickType, price, attribs) {
    const key = String(reqId);
    const rec = this.quoteRequests.get(key);
    if (!rec) return;
    const field = TICK_PRICE_FIELDS[Number(tickType)];
    const n = finiteNumber(price);
    if (field && n != null && n > 0) rec.quote[field] = n;
    rec.raw.tickPrice.push({ tickType: Number(tickType), field, price: n, attribs: safeClone(attribs) });
    const quote = this.#normalizedQuote(rec);
    if (quote) this.#resolveQuote(key, quote, 'resolved');
  }

  #handleTickSize(reqId, tickType, size) {
    const key = String(reqId);
    const rec = this.quoteRequests.get(key);
    if (!rec) return;
    rec.raw.tickSize.push({ tickType: Number(tickType), size: finiteNumber(size) });
  }

  #handleMarketDataType(reqId, marketDataType) {
    const key = String(reqId);
    const rec = this.quoteRequests.get(key);
    if (!rec) return;
    const type = Number(marketDataType);
    rec.raw.observedMarketDataType = type;
    this.#appendQuoteDiagnosticSample(rec, 'marketDataType', { marketDataType: type });
    this.#log('info', 'market data type received', this.#quoteDiagnosticContext(rec, { marketDataType: type }));
  }

  #handleRerouteMktDataReq(reqId, conId, exchange) {
    const key = String(reqId);
    const rec = this.quoteRequests.get(key);
    if (!rec) return;
    const sample = { conId: Number(conId), exchange: normalizeString(exchange) };
    this.#appendQuoteDiagnosticSample(rec, 'rerouteMktDataReq', sample);
    this.#log('info', 'market data reroute received', this.#quoteDiagnosticContext(rec, { reroute: sample }));
    if (rec.reroutedMarketData === true) return;
    const reroutedContract = this.#buildReroutedMarketDataContract(rec, sample);
    if (!reroutedContract) {
      this.#log('error', 'market data reroute ignored', this.#quoteDiagnosticContext(rec, { reason: 'invalid-reroute-contract', reroute: sample }));
      return;
    }
    rec.reroutedMarketData = true;
    rec.activeMarketDataContract = reroutedContract;
    this.#cancelQuoteRequest(key);
    try {
      this.client.reqMktData(Number(reqId), reroutedContract, '', this.cfg.snapshotQuotes === true, false, []);
      this.#log('info', 'market data reroute requested', this.#quoteDiagnosticContext(rec, { reroute: sample, reroutedContract: safeContractSummary(reroutedContract) }));
    } catch (err) {
      this.#log('error', 'market data reroute failed', this.#quoteDiagnosticContext(rec, { reroute: sample, message: err?.message || String(err) }));
      this.#resolveQuote(key, null, 'reroute-request-error');
    }
  }

  #handleTickReqParams(reqId, minTick, bboExchange, snapshotPermissions) {
    const key = String(reqId);
    const rec = this.quoteRequests.get(key);
    if (!rec) return;
    const sample = { minTick: finiteNumber(minTick), bboExchange: normalizeString(bboExchange), snapshotPermissions: finiteNumber(snapshotPermissions) };
    this.#appendQuoteDiagnosticSample(rec, 'tickReqParams', sample);
    this.#log('info', 'tick request params received', this.#quoteDiagnosticContext(rec, { tickReqParams: sample }));
  }

  #handleQuoteDiagnosticEvent(reqId, key, sample) {
    const rec = this.quoteRequests.get(String(reqId));
    if (!rec) return;
    this.#appendQuoteDiagnosticSample(rec, key, sample);
  }

  #handleTickSnapshotEnd(reqId) {
    const key = String(reqId);
    const rec = this.quoteRequests.get(key);
    if (!rec) return;
    const quote = this.#normalizedQuote(rec);
    if (quote) this.#resolveQuote(key, quote, 'snapshot-end');
    if (rec.raw?.snapshot) this.#closeQuoteStream(key, quote ? 'snapshot-end' : 'snapshot-end-no-price', { cancel: false, resolveWaiters: !quote });
  }

  allocateOrderId() {
    const reason = this.readinessReason();
    if (reason) throw createContextError(reason, { adapter: 'ibkr', phase: 'allocateOrderId' });
    const id = Math.max(Number(this.nextOrderId), this.maxObservedOrderId + 1);
    this.nextOrderId = id + 1;
    this.maxObservedOrderId = Math.max(this.maxObservedOrderId, id);
    return id;
  }

  getContractForSymbol(symbol) {
    const key = normalizeString(symbol);
    const contractCfg = this.cfg.instruments[key];
    const reason = validateContract(key, contractCfg);
    if (reason) throw createContextError(reason, { adapter: 'ibkr', symbol: key });
    return normalizeContract(contractCfg);
  }

  getStaticContractRecordForSymbol(symbol) {
    const key = normalizeString(symbol);
    const contractCfg = this.cfg.instruments[key];
    if (!contractCfg) return null;
    const reason = validateContract(key, contractCfg);
    if (reason) throw createContextError(reason, { adapter: 'ibkr', symbol: key });
    return { contract: normalizeContract(contractCfg), tickSize: configuredTickSize(contractCfg, this.cfg), source: 'static' };
  }

  async resolveContractRecordForSymbol(symbol) {
    const key = normalizeString(symbol).toUpperCase();
    if (!key) throw createContextError('IBKR symbol is required for contract resolution', { adapter: 'ibkr' });

    const staticRecord = this.getStaticContractRecordForSymbol(key);
    if (staticRecord) return { ...staticRecord, profile: { name: 'STATIC', cacheKey: 'STATIC' }, cacheKey: this.#contractCacheKey(key, { cacheKey: 'STATIC' }) };

    const profile = this.#selectContractResolutionProfile(key);
    const cacheKey = this.#contractCacheKey(key, profile);
    const cached = this.resolvedContracts.get(cacheKey);
    if (cached) return cached;

    if (this.cfg.contractResolution.enabled === false) {
      throw createContextError(`IBKR contract mapping missing for ${key} and dynamic contractResolution is disabled`, { adapter: 'ibkr', symbol: key });
    }
    if (!this.client || typeof this.client.reqContractDetails !== 'function') {
      throw createContextError('IBKR client does not support reqContractDetails', { adapter: 'ibkr', symbol: key });
    }

    const reqId = this.#allocateContractReqId();
    const reqKey = String(reqId);
    const request = this.#buildDefaultContractRequest(key, profile);
    this.#log('info', 'IBKR contract resolution started', { provider: this.provider, reqId, symbol: key, profile: profile.name, contract: safeContractSummary(request) });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const rec = this.contractRequests.get(reqKey);
        if (!rec) return;
        if (rec.candidates.length) {
          try {
            const selected = this.#selectResolvedContract(rec.symbol, rec.candidates, rec.profile);
            this.#resolveContract(reqKey, selected);
          } catch (err) {
            this.#resolveContract(reqKey, null, err.message, err.context);
          }
        } else {
          this.#resolveContract(reqKey, null, `IBKR could not resolve contract for ${key}`, { adapter: 'ibkr', symbol: key, candidates: [] });
        }
      }, this.cfg.contractResolveTimeoutMs);
      this.contractRequests.set(reqKey, { reqId, symbol: key, request, profile, cacheKey, candidates: [], resolve, reject, timer });
      try {
        this.client.reqContractDetails(reqId, request);
      } catch (err) {
        this.#resolveContract(reqKey, null, `IBKR contract resolution failed for ${key}: ${err?.message || String(err)}`, { adapter: 'ibkr', symbol: key });
      }
    });
  }

  async resolveContractForSymbol(symbol) {
    const record = await this.resolveContractRecordForSymbol(symbol);
    return record.contract;
  }

  buildOrderRequests(order, contractOverride) {
    const contract = contractOverride || this.getContractForSymbol(order?.symbol);
    return buildOrderRequests(order, contract, this.cfg, () => this.allocateOrderId());
  }

  async getInstrumentMetadata(symbol) {
    const key = normalizeString(symbol).toUpperCase();
    try {
      const record = await this.resolveContractRecordForSymbol(key);
      return {
        tickSize: record.tickSize || positiveNumber(this.cfg.defaultTickSize),
        contractSize: positiveNumber(record.contract?.multiplier),
        sources: {
          tickSize: record.source === 'static' ? 'ibkr-config' : 'ibkr-contract-details',
          contractSize: record.source === 'static' ? 'ibkr-config' : 'ibkr-contract-details'
        }
      };
    } catch (err) {
      this.#log('error', 'instrument metadata unavailable', { provider: this.provider, symbol: key, reason: err.message });
      return null;
    }
  }

  async getQuote(symbol) {
    const key = normalizeString(symbol).toUpperCase();
    const reason = this.readinessReason();
    if (reason) {
      this.#log('error', 'quote unavailable: adapter not ready', { provider: this.provider, symbol: key, reason });
      return null;
    }

    let contractRecord;
    try {
      contractRecord = await this.resolveContractRecordForSymbol(key);
    } catch (err) {
      this.#log('error', 'quote unavailable: contract resolution failed', { provider: this.provider, symbol: key, reason: err.message, context: err.context });
      return null;
    }
    const contract = contractRecord.contract;

    if (!this.client || typeof this.client.reqMktData !== 'function') {
      this.#log('error', 'quote unavailable: IBKR client does not support reqMktData', { provider: this.provider, symbol: key });
      return null;
    }

    const quoteKey = this.#contractCacheKey(key, contractRecord.profile);
    const existingReqId = this.quoteRequestsBySymbol.get(quoteKey);
    if (existingReqId) return this.#waitForQuote(existingReqId);

    const reqId = this.#allocateQuoteReqId();
    const reqKey = String(reqId);
    const marketDataType = Number(this.cfg.marketDataType);
    const tickSize = contractRecord.tickSize || positiveNumber(this.cfg.defaultTickSize);
    const quoteRec = {
      reqId,
      symbol: key,
      quoteKey,
      profile: contractRecord.profile?.name,
      contract,
      tickSize,
      startedAt: Date.now(),
      quote: {},
      raw: {
        tickPrice: [],
        tickSize: [],
        marketDataType: [],
        rerouteMktDataReq: [],
        tickReqParams: [],
        tickString: [],
        tickGeneric: [],
        tickOptionComputation: [],
        errors: [],
        marketDataTypeRequested: marketDataType,
        snapshot: this.cfg.snapshotQuotes === true,
      },
      waiters: [],
    };

    this.#log('info', 'quote request started', this.#quoteDiagnosticContext(quoteRec, { marketDataType }));
    if (typeof this.client.reqMarketDataType === 'function') {
      try {
        this.client.reqMarketDataType(marketDataType);
      } catch (err) {
        this.#log('error', 'reqMarketDataType failed', { provider: this.provider, reqId, symbol: key, marketDataType, message: err?.message || String(err) });
      }
    }

    this.#startQuoteStream(reqId, quoteRec);
    return this.#waitForQuote(reqKey);
  }

  async forgetQuote(symbol) {
    const key = normalizeString(symbol).toUpperCase();
    for (const [quoteKey, reqId] of Array.from(this.quoteRequestsBySymbol.entries())) {
      if (quoteKey === key || quoteKey.startsWith(`${key}|`)) this.#resolveQuote(reqId, null, 'forgotten');
    }
  }

  async placeOrder(order) {
    if (!this.cfg.enabled) return { status: 'disabled', provider: this.provider, reason: 'IBKR adapter is disabled' };
    const reason = this.readinessReason();
    if (reason) return { status: 'rejected', provider: this.provider, reason };
    let cid = getClientOrderId(order);
    if (!order.meta) order.meta = {};
    order.meta.cid = cid;

    let logical;
    try {
      const contractRecord = await this.resolveContractRecordForSymbol(order?.symbol);
      const requests = this.buildOrderRequests(order, contractRecord.contract);
      const parent = requests.find(req => req.role === 'parent') || requests[0];
      const positionKey = this.#positionKey(this.selectedAccount, parent.contract);
      const baselineQty = this.currentPositions.get(positionKey)?.quantity || 0;
      logical = {
        cid,
        parentId: String(parent.orderId),
        origOrder: order,
        contract: safeClone(parent.contract),
        contractIdentity: contractIdentity(parent.contract),
        positionKey,
        account: this.selectedAccount,
        entryAction: normalizeExecutionSide(parent.order.action),
        requestedQty: positiveNumber(parent.order.totalQuantity) || 0,
        entryFilled: 0,
        exitFilled: 0,
        confirmed: false,
        openedEmitted: false,
        rejected: false,
        baselineKnown: this.positionsInitialized,
        baselineQty,
        externalInferenceSafe: this.positionsInitialized && Math.abs(baselineQty) < 1e-9,
        closingExecutionFamilies: new Set(),
        pnlByExecutionFamily: new Map(),
        closeTimer: null,
        unavailableEmitted: false,
        reportedEmitted: false,
        lastEmittedProfit: undefined,
      };
      this.logicalPositions.set(logical.parentId, logical);
      this.logicalPositionsByCid.set(cid, logical);
      for (const req of requests) {
        const orderId = String(req.orderId);
        const link = { logical, role: req.role || (orderId === logical.parentId ? 'parent' : 'child') };
        this.orderIdToLogical.set(orderId, link);
        this.pending.set(orderId, { cid, order, request: safeClone(req), role: link.role, logical, createdAt: Date.now() });
      }
      this.#log('info', 'placing order', { provider: this.provider, symbol: order.symbol, cid, orderIds: requests.map(r => r.orderId), contract: safeContractSummary(requests[0].contract), orderType: requests[0].order.orderType });
      for (const req of requests) {
        this.client.placeOrder(req.orderId, req.contract, req.order);
      }
      return { status: 'ok', provider: this.provider, providerOrderId: `pending:${cid}`, raw: { orderIds: requests.map(r => r.orderId), bracket: requests.length === 3 } };
    } catch (err) {
      if (logical && !logical.confirmed) {
        this.logicalPositions.delete(logical.parentId);
        this.logicalPositionsByCid.delete(logical.cid);
        for (const [orderId, link] of this.orderIdToLogical.entries()) {
          if (link.logical === logical) {
            this.orderIdToLogical.delete(orderId);
            this.pending.delete(orderId);
          }
        }
      }
      this.#log('error', 'order rejected before send', { provider: this.provider, symbol: order?.symbol, cid, reason: err.message });
      return { status: 'rejected', provider: this.provider, reason: err.message, raw: { context: err.context } };
    }
  }

  #confirmPending(orderId, ticket, raw) {
    const rec = this.pending.get(orderId);
    if (!rec) return;
    this.pending.delete(orderId);
    if (rec.role !== 'parent' || rec.logical.confirmed || rec.logical.rejected) return;
    rec.logical.confirmed = true;
    for (const [pendingOrderId, pendingRec] of this.pending.entries()) {
      if (pendingRec.logical === rec.logical) this.pending.delete(pendingOrderId);
    }
    this.events.emit('order:confirmed', { pendingId: rec.cid, ticket: rec.logical.parentId, mtOrder: raw, origOrder: rec.order });
    this.#emitPositionOpened(rec.logical, null, rec.logical.contract);
    this.#tryFinalizeLogicalPosition(rec.logical);
  }

  #rejectPending(orderId, reason, raw) {
    const rec = this.pending.get(orderId);
    if (!rec) return;
    this.pending.delete(orderId);
    if (rec.logical.confirmed || rec.logical.rejected) {
      this.#log('error', 'IBKR attached order rejected after parent confirmation', { provider: this.provider, orderId, role: rec.role, reason });
      return;
    }
    rec.logical.rejected = true;
    for (const [pendingOrderId, pendingRec] of this.pending.entries()) {
      if (pendingRec.logical === rec.logical) this.pending.delete(pendingOrderId);
    }
    this.events.emit('order:rejected', { pendingId: rec.cid, reason, msg: reason, raw, origOrder: rec.order });
  }

  async cancelOrder(orderId) {
    if (!this.cfg.enabled) return { status: 'disabled', provider: this.provider, reason: 'IBKR adapter is disabled' };
    const reason = this.readinessReason();
    if (reason) return { status: 'error', provider: this.provider, reason };
    const ticket = normalizeString(orderId).replace(/^pending:/, '');
    if (!/^\d+$/.test(ticket)) return { status: 'error', provider: this.provider, reason: 'IBKR cancelOrder requires numeric order ID' };
    this.#log('info', 'cancel requested', { provider: this.provider, orderId: ticket });
    this.client.cancelOrder(Number(ticket));
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.cancels.delete(ticket);
        resolve({ status: 'pending', provider: this.provider, providerOrderId: ticket, reason: 'IBKR cancel request sent; awaiting orderStatus cancellation confirmation' });
      }, Number(this.cfg.cancelConfirmTimeoutMs || 5000));
      this.cancels.set(ticket, { resolve, timer });
    });
  }
}

module.exports = {
  IBKRAdapter,
  validateConfig,
  validateContract,
  buildOrderRequests,
  safeClone,
  safeContractSummary,
};
