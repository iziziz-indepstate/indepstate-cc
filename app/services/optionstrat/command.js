const { Command } = require('../commands/base');

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

class OptionStratCommand extends Command {
  constructor(definition, opts = {}) {
    const tokens = tokenizeTemplate(definition.command);
    super(tokens[0]);
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

function createOptionStratCommands(config = {}, opts = {}) {
  const commands = Array.isArray(config.commands) ? config.commands : [];
  return commands
    .filter(def => def && def.enabled !== false && def.command)
    .map(def => new OptionStratCommand(def, opts));
}

module.exports = {
  OptionStratCommand,
  createOptionStratCommands,
  buildOptionStratRow,
  fillTemplate,
  tokenizeTemplate
};
