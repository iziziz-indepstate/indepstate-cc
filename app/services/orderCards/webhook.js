// services/orderCards/webhook.js
// Implementation of order card source based on incoming webhooks.

const express = require('express');
const fs = require('fs');
const path = require('path');

const { parseWebhook } = require('../webhooks');
const { OrderCardsSource } = require('./base');

const DEFAULT_WEBHOOK_PORT = 3210;

function sanitizePort(candidate, fallback = DEFAULT_WEBHOOK_PORT) {
  const num = Number(candidate);
  if (!Number.isFinite(num)) return fallback;
  const port = Math.trunc(num);
  if (port <= 0 || port > 65535) return fallback;
  return port;
}

class WebhookOrderCardsSource extends OrderCardsSource {
  constructor(opts = {}) {
    super();
    this.port = sanitizePort(opts.port);
    this.nowTs = opts.nowTs || (() => Date.now());
    const userData = require('electron')?.app?.getPath('userData') || path.join(__dirname, '..');
    this.logFile = opts.logFile || path.join(userData, 'logs', 'webhooks.jsonl');
    this.onRow = typeof opts.onRow === 'function' ? opts.onRow : () => {};
    this.truncateOnStart = opts.truncateOnStart || false;
    this.server = null;
  }

  ensureLog() {
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.logFile)) fs.writeFileSync(this.logFile, '');
    if (this.truncateOnStart) fs.writeFileSync(this.logFile, '');
  }

  appendJsonl(file, obj) {
    try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
    catch (e) { console.error('appendJsonl error:', e); }
  }

  async start() {
    this.ensureLog();
    const srv = express();
    srv.use(express.text({ type: '*/*', limit: '256kb' }));

    srv.post('/webhook', (req, res) => {
      const t = this.nowTs();
        try {
          const raw = req.body || '';
          const parsed = parseWebhook(String(raw), () => t);
          if (!parsed) throw new Error('Invalid payload');
        const row = parsed.row;
        row.time = row.time || t;
        this.appendJsonl(this.logFile, { t, kind: 'webhook', parser: parsed.name, row });
        this.onRow(row);
        res.json({ status: 'ok' });
      } catch (e) {
        this.appendJsonl(this.logFile, { t, kind: 'webhook-error', error: String(e) });
        res.status(400).json({ status: 'error', error: String(e) });
      }
    });

    await new Promise((resolve, reject) => {
      this.server = srv.listen(this.port, (err) => {
        if (err) return reject(err);
        console.log(`Express listening on http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    await new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  async list({ rows = 100 } = {}) {
    let text = '';
    try {
      text = fs.readFileSync(this.logFile, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }

    const lines = text.split('\n').filter(Boolean);
    const tail = lines.slice(-Math.max(1, rows));
    const result = [];
    for (const l of tail) {
      try {
        const rec = JSON.parse(l);
        if (rec && rec.kind === 'webhook' && rec.row) {
          result.push(rec.row);
        } else if (rec && rec.payload) {
          // compatibility with old records
          result.push({
            ticker: rec.payload.ticker,
            event: rec.payload.event,
            price: rec.payload.price,
            time: rec.t || this.nowTs(),
          });
        }
      } catch {
        // skip bad line
      }
    }
    return result;
  }
}

module.exports = { WebhookOrderCardsSource };
