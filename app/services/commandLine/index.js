// services/commandLine.js
// Parses and executes text commands using registered command objects
// Commands may expose multiple names/aliases

const { AddCommand } = require('../commands/add');
const { RemoveCommand } = require('../commands/remove');
const { CurrentOrderCommand } = require('../commands/currentOrder');

const MAX_ALIAS_DEPTH = 5;

function normalizeAliases(aliases) {
  return Array.isArray(aliases)
    ? aliases
        .filter(a => a && a.enabled !== false && a.from && a.to)
        .map(a => ({
          from: String(a.from).trim().toLowerCase(),
          to: String(a.to).trim()
        }))
        .filter(a => a.from && a.to)
    : [];
}

function expandAlias(input, aliases) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return trimmed;
  const [cmd, ...args] = trimmed.split(/\s+/);
  const alias = aliases.find(a => a.from === String(cmd || '').toLowerCase());
  if (!alias) return trimmed;

  const argText = args.join(' ');
  if (alias.to.includes('{args}')) {
    return alias.to.replace(/\{args\}/g, argText).trim();
  }
  return [alias.to, argText].filter(Boolean).join(' ').trim();
}

function createCommandService(opts = {}) {
  let aliases = normalizeAliases(opts.aliases);
  const extra = Array.isArray(opts.commands)
    ? opts.commands.map(c => {
        if (c && typeof c === 'object') {
          if (c.onAdd == null) c.onAdd = opts.onAdd;
          if (c.onRemove == null) c.onRemove = opts.onRemove;
        }
        return c;
      })
    : [];
  const list = [
    new AddCommand({ onAdd: opts.onAdd }),
    new RemoveCommand({ onRemove: opts.onRemove }),
    new CurrentOrderCommand('limit', { executionApi: opts.executionApi }),
    new CurrentOrderCommand('market', { executionApi: opts.executionApi }),
    ...extra
  ];

  function run(str, context = {}, depth = 0) {
    if (!str) return { ok: false, error: 'Empty command' };
    const input = String(str).trim();
    if (!input) return { ok: false, error: 'Empty command' };
    const expanded = expandAlias(input, aliases);
    if (expanded !== input) {
      if (depth >= MAX_ALIAS_DEPTH) {
        return { ok: false, error: 'Command alias loop detected' };
      }
      return run(expanded, context, depth + 1);
    }

    const [cmd, ...args] = input.split(/\s+/);
    const key = (cmd || '').toLowerCase();
    const handler = list.find(c => {
      const names = Array.isArray(c.names) && c.names.length ? c.names : [c.name];
      return names.some(n => String(n).toLowerCase() === key);
    });
    if (!handler) {
      return { ok: false, error: `Unknown command: ${cmd}` };
    }
    try {
      return handler.run(args, context);
    } catch (e) {
      return { ok: false, error: e.message || 'Command error' };
    }
  }

  function configure({ aliases: nextAliases } = {}) {
    if (nextAliases !== undefined) aliases = normalizeAliases(nextAliases);
  }

  function replaceCommands(predicate, commands = []) {
    if (typeof predicate !== 'function') return;
    for (let i = list.length - 1; i >= 2; i -= 1) {
      if (predicate(list[i])) list.splice(i, 1);
    }
    list.push(...commands);
  }

  return { run, configure, replaceCommands };
}

module.exports = { createCommandService, expandAlias, normalizeAliases };
