const { Command } = require('../commands/base');

const RESERVED_ROW_PROPS = new Set(['cardType', 'ticker', 'level', 'event', 'time']);
const PROPS_USAGE = 'Usage: levelOrder {ticker} {level} [props=key:value;key2:value2]';

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

module.exports = {
  LevelOrderCommand,
  buildLevelOrderRow,
  normalizeTicker,
  parsePropsToken
};
