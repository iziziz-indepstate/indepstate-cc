const { Command } = require('../commands/base');
const { resolveLevelOrderDefaults } = require('./strategy');

const RESERVED_ROW_PROPS = new Set(['cardType', 'ticker', 'level', 'event', 'time']);
const PROPS_USAGE = 'Usage: levelOrder {ticker} {level} [props=key:value;key2:value2]';
const PLACE_USAGE = 'Usage: levelOrder-{buy|sell} {ticker} {level} {levelOffset} {risk}';

function normalizeTicker(ticker) {
  const raw = String(ticker || '').trim();
  if (!raw) return '';
  const dot = raw.indexOf('.');
  if (dot >= 0) {
    return raw.slice(0, dot).toUpperCase() + raw.slice(dot);
  }
  return raw.toUpperCase();
}

function parseNumber(value) {
  const n = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parsePropsToken(token) {
  const raw = String(token || '');
  if (!raw.startsWith('props=')) return null;
  const body = raw.slice('props='.length);
  if (!body) return { ok: true, props: {} };
  const props = {};
  const pairs = body.split(';').filter(Boolean);
  for (const pair of pairs) {
    const sepIdx = pair.indexOf(':');
    if (sepIdx <= 0) return { ok: false, error: PROPS_USAGE };
    const key = pair.slice(0, sepIdx).trim();
    const value = pair.slice(sepIdx + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !value) {
      return { ok: false, error: PROPS_USAGE };
    }
    if (!RESERVED_ROW_PROPS.has(key)) props[key] = value;
  }
  return { ok: true, props };
}

function buildLevelOrderRow(args, now = Date.now()) {
  const [tickerRaw, levelRaw, ...rest] = args || [];
  const ticker = normalizeTicker(tickerRaw);
  const level = parseNumber(levelRaw);
  if (!ticker || !Number.isFinite(level) || level <= 0) {
    return { ok: false, error: PROPS_USAGE };
  }
  let props = {};
  for (const token of rest) {
    const parsed = parsePropsToken(token);
    if (!parsed) return { ok: false, error: PROPS_USAGE };
    if (!parsed.ok) return parsed;
    props = { ...props, ...parsed.props };
  }
  return {
    ok: true,
    row: {
      ...props,
      cardType: 'levelOrder',
      ticker,
      level,
      event: 'levelOrder',
      time: now
    }
  };
}

class LevelOrderCommand extends Command {
  constructor(opts = {}) {
    super(['levelOrder', 'lo']);
    this.onAdd = opts.onAdd;
    this.now = opts.now || Date.now;
  }

  run(args) {
    const built = buildLevelOrderRow(args, this.now());
    if (!built.ok) return built;
    if (typeof this.onAdd === 'function') this.onAdd(built.row);
    return { ok: true };
  }
}

class LevelOrderPlaceCommand extends Command {
  constructor(action, opts = {}) {
    const normalizedAction = String(action || '').toUpperCase() === 'LS' ? 'LS' : 'LB';
    super(normalizedAction === 'LB' ? ['levelOrder-buy', 'lo-lb'] : ['levelOrder-sell', 'lo-ls']);
    this.action = normalizedAction;
    this.servicesApi = opts.servicesApi || {};
    this.getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
    this.now = opts.now || Date.now;
  }

  async run(args) {
    const [tickerRaw, levelRaw, offsetRaw, riskRaw] = Array.isArray(args) ? args : [];
    const ticker = normalizeTicker(tickerRaw);
    const level = parseNumber(levelRaw);
    const stopOffsetPts = parseNumber(offsetRaw);
    const riskUsd = parseNumber(riskRaw);
    if (
      !ticker ||
      !Number.isFinite(level) || level <= 0 ||
      !Number.isFinite(stopOffsetPts) || stopOffsetPts <= 0 ||
      !Number.isFinite(riskUsd) || riskUsd <= 0
    ) {
      return { ok: false, error: PLACE_USAGE };
    }

    const queueLevelOrder = this.servicesApi.execution?.queueLevelOrder;
    if (typeof queueLevelOrder !== 'function') {
      return { ok: false, error: 'Level order execution queue is not available' };
    }

    const cfg = this.getConfig() || {};
    const defaults = resolveLevelOrderDefaults(cfg, ticker);
    const requestId = `${this.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const strategyId = `${requestId}_${this.action.toLowerCase()}`;
    const payload = {
      ticker,
      action: this.action,
      level,
      riskUsd,
      stopOffsetPts,
      maxLot: defaults.maxLot,
      minLot: defaults.minLot,
      takeProfitPts: defaults.takeProfitPts,
      buyPriceSource: defaults.buyPriceSource,
      sellPriceSource: defaults.sellPriceSource,
      requestId,
      strategyId,
      meta: {
        source: 'commandLine',
        command: this.name
      }
    };

    const result = await queueLevelOrder(payload);
    if (!result || result.status === 'rejected' || result.status === 'error') {
      return { ok: false, error: result?.reason || 'Level order rejected', result };
    }
    return { ok: true, result };
  }
}

module.exports = {
  LevelOrderCommand,
  LevelOrderPlaceCommand,
  buildLevelOrderRow,
  normalizeTicker,
  parsePropsToken
};
