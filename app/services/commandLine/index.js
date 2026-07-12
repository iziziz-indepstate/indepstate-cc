// services/commandLine.js
// Parses and executes text commands using registered command objects
// Commands may expose multiple names/aliases

const { AddCommand } = require('../commands/add');
const { RemoveCommand } = require('../commands/remove');
const { CurrentOrderCommand } = require('../commands/currentOrder');

function createCommandService(opts = {}) {
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

  function run(str) {
    if (!str) return { ok: false, error: 'Empty command' };
    const [cmd, ...args] = str.trim().split(/\s+/);
    const key = (cmd || '').toLowerCase();
    const handler = list.find(c => {
      const names = Array.isArray(c.names) && c.names.length ? c.names : [c.name];
      return names.some(n => String(n).toLowerCase() === key);
    });
    if (!handler) {
      return { ok: false, error: `Unknown command: ${cmd}` };
    }
    try {
      return handler.run(args);
    } catch (e) {
      return { ok: false, error: e.message || 'Command error' };
    }
  }

  return { run };
}

module.exports = { createCommandService };
