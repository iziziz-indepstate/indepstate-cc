const { Command } = require('../commands/base');
const { parseOptionSymbol } = require('../brokerage-adapter-optionstrat/comps/optionstrat');

function tokenizeTemplate(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

function variableName(token) {
  const match = String(token || '').match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return match ? match[1] : null;
}

function fillTemplate(value, vars) {
  return String(value ?? '').replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key) => {
    return vars[key] == null ? '' : String(vars[key]);
  });
}

function numericTemplate(value, vars, fieldName) {
  const rendered = fillTemplate(value, vars).trim().replace(',', '.');
  const num = Number(rendered);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid ${fieldName}: ${rendered}`);
  }
  return num;
}

function numericArgValue(value) {
  const num = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function applyRangeAliases(vars) {
  const values = Object.entries(vars)
    .filter(([key]) => key !== 'q')
    .map(([, value]) => numericArgValue(value))
    .filter(value => value != null);
  if (!values.length) return;
  vars.min = Math.min(...values);
  vars.max = Math.max(...values);
}

function buildOptionStratRow(definition, args, now = Date.now()) {
  const tokens = tokenizeTemplate(definition.command);
  if (!tokens.length) throw new Error('OptionStrat command template is empty');
  const strategyCommand = String(tokens[0] || '').toLowerCase();
  const argTokens = tokens.slice(1);
  const allowsDefaultQuantityArg = argTokens.length > 0
    && variableName(argTokens[argTokens.length - 1]) === 'q'
    && args.length === argTokens.length - 1;
  if (args.length !== argTokens.length && !allowsDefaultQuantityArg) {
    return {
      ok: false,
      error: `Usage: ${definition.command}`
    };
  }
  const vars = { q: 1 };
  const providedArgCount = Math.min(args.length, argTokens.length);
  for (let i = 0; i < providedArgCount; i += 1) {
    const name = variableName(argTokens[i]);
    if (!name) {
      if (String(argTokens[i]).toLowerCase() !== String(args[i]).toLowerCase()) {
        return { ok: false, error: `Usage: ${definition.command}` };
      }
      continue;
    }
    vars[name] = args[i];
  }
  applyRangeAliases(vars);

  const ticker = fillTemplate(definition.ticker || 'SPY', vars).trim().toUpperCase();
  const root = fillTemplate(definition.root || '', vars).trim().toUpperCase();
  const legs = (definition.legs || []).map((leg) => ({
    option: fillTemplate(leg.option || 'CALL', vars).trim().toUpperCase(),
    side: fillTemplate(leg.side || 'buy', vars).trim().toLowerCase(),
    strike: numericTemplate(leg.strike, vars, 'strike'),
    quantity: numericTemplate(leg.quantity == null ? '{q}' : leg.quantity, vars, 'quantity')
  }));
  if (!legs.length) {
    throw new Error(`OptionStrat command ${tokens[0]} has no legs`);
  }

  return {
    ok: true,
    row: {
      ticker,
      symbol: ticker,
      root: root || undefined,
      provider: definition.provider || 'optionstrat',
      instrumentType: 'OPT',
      event: 'optionstrat',
      strategyCommand,
      time: now,
      name: fillTemplate(definition.name || `${ticker} Option Strategy`, vars),
      description: fillTemplate(definition.description || '', vars),
      expirationDte: fillTemplate(definition.expiration || definition.expirationDte || '0DTE', vars).trim(),
      instantExecution: definition.instantExecution === true,
      isCustomName: definition.isCustomName === true,
      isCashSecured: definition.isCashSecured === true,
      legs
    }
  };
}

function attachedTimeValue(raw = {}, now = Date.now()) {
  const value = raw.openedAt || raw.createdAt || raw.created || raw.updatedAt || raw.updated;
  if (value == null || value === '') return now;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10000000000 ? numeric * 1000 : numeric;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : now;
}

function buildAttachedOptionStratRow({ id, provider = 'optionstrat', raw = {}, payoff, valuation, now = Date.now() } = {}) {
  const ticket = String(id || raw.code || raw.id || '').trim();
  if (!ticket) throw new Error('OptionStrat strategy id is required');
  const strategy = raw.strategy || {};
  const items = Array.isArray(strategy.items) ? strategy.items : [];
  if (!items.length) throw new Error(`OptionStrat strategy ${ticket} has no legs`);

  let ticker = '';
  let expiration = '';
  const legs = items.map((item) => {
    const parsed = parseOptionSymbol(item.symbol);
    if (!ticker) ticker = parsed.ticker;
    if (!expiration) expiration = parsed.expiration;
    const signedQty = Number(item.quantity ?? item.qty);
    if (!Number.isFinite(signedQty) || signedQty === 0) {
      throw new Error(`Invalid OptionStrat leg quantity for ${item.symbol}`);
    }
    return {
      option: parsed.option,
      side: signedQty < 0 ? 'sell' : 'buy',
      strike: parsed.strike,
      quantity: Math.abs(signedQty),
      basis: Number(item.basis)
    };
  });

  const strategySymbol = String(strategy.symbol || '').toUpperCase();
  const root = String(raw.root || raw.chainRoot || (strategySymbol && strategySymbol !== ticker ? strategySymbol : '') || '').toUpperCase();
  const openedAt = attachedTimeValue(raw, now);

  return {
    ticker,
    symbol: ticker,
    root: root || undefined,
    provider,
    providerOrderId: ticket,
    instrumentType: 'OPT',
    event: 'optionstrat',
    strategyCommand: 'attach',
    time: openedAt,
    name: raw.name || `${ticker} Option Strategy`,
    description: raw.description || '',
    expirationDte: expiration || raw.expiration || '',
    isCustomName: raw.isCustomName === true,
    isCashSecured: strategy.isCashSecured === true,
    attached: true,
    openedAt,
    payoff: payoff || raw.payoff || raw.estimatedPayoff,
    estimatedPayoff: raw.estimatedPayoff || payoff || raw.payoff,
    valuation: valuation || raw.valuation,
    legs
  };
}

class OptionStratCommand extends Command {
  constructor(definition, opts = {}) {
    const tokens = tokenizeTemplate(definition.command);
    super(tokens[0]);
    this.isOptionStratCommand = true;
    this.definition = definition;
    this.onAdd = opts.onAdd;
    this.now = opts.now || Date.now;
  }

  run(args) {
    const built = buildOptionStratRow(this.definition, args, this.now());
    if (!built.ok) return built;
    if (typeof this.onAdd === 'function') this.onAdd(built.row);
    return { ok: true };
  }
}

class OptionStratAttachCommand extends Command {
  constructor(opts = {}) {
    super('optionstrat');
    this.isOptionStratCommand = true;
    this.onAdd = opts.onAdd;
    this.executionApi = opts.executionApi;
    this.provider = opts.provider || 'optionstrat';
    this.now = opts.now || Date.now;
  }

  async run(args) {
    const [subcommand, id] = args || [];
    if (String(subcommand || '').toLowerCase() !== 'attach' || !id || args.length !== 2) {
      return { ok: false, error: 'Usage: optionstrat attach {id}' };
    }
    const adapter = this.executionApi?.brokerage?.getAdapter?.(this.provider);
    if (!adapter || typeof adapter.attachStrategy !== 'function') {
      return { ok: false, error: 'OptionStrat attach is not supported by the configured adapter' };
    }
    const result = await adapter.attachStrategy(id);
    if (result?.status !== 'ok') {
      return { ok: false, error: result?.reason || 'OptionStrat attach failed' };
    }
    const row = buildAttachedOptionStratRow({
      id,
      provider: result.provider || this.provider,
      raw: result.raw,
      payoff: result.payoff,
      valuation: result.valuation,
      now: this.now()
    });
    if (typeof this.onAdd === 'function') this.onAdd(row);
    return { ok: true, row };
  }
}

function createOptionStratCommands(config = {}, opts = {}) {
  const commands = Array.isArray(config.commands) ? config.commands : [];
  return [
    new OptionStratAttachCommand(opts),
    ...commands
    .filter(def => def && def.enabled !== false && def.command)
    .map(def => new OptionStratCommand(def, opts))
  ];
}

module.exports = {
  OptionStratCommand,
  OptionStratAttachCommand,
  createOptionStratCommands,
  buildOptionStratRow,
  buildAttachedOptionStratRow,
  fillTemplate,
  tokenizeTemplate
};
