const { Command } = require('../commands/base');
const { parseWebhookCommandArgs } = require('.');

class WebhookCommand extends Command {
  constructor(opts = {}) {
    super(['wh', 'webhook']);
    this.sender = opts.sender;
  }

  run(args) {
    const parsed = parseWebhookCommandArgs(args);
    if (!parsed.ok) return parsed;
    if (!this.sender || typeof this.sender.send !== 'function') {
      return { ok: false, error: 'Outbound webhook sender not available' };
    }
    return this.sender.send(parsed.target, parsed.payload);
  }
}

module.exports = { WebhookCommand };
