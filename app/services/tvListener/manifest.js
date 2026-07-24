const path = require('path');
const fetch = require('node-fetch');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { AddCommand } = require('../commands/add');
const { stripSymbol } = require('./actionFunctions');

settings.register(
  'tv-listener',
  path.join(__dirname, 'config', 'tv-listener.json'),
  path.join(__dirname, 'config', 'tv-listener-settings-descriptor.json')
);

function intVal(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function registerActionFunctions(servicesApi = {}) {
  const bus = servicesApi.actionBus;
  if (!bus || typeof bus.registerActionFunction !== 'function') return [];
  return [bus.registerActionFunction('stripSymbol', stripSymbol)].filter(Boolean);
}

function initService(servicesApi = {}) {
  registerActionFunctions(servicesApi);
  const tvApi = servicesApi.tvListener = servicesApi.tvListener || {};

  let lastActivity = null;
  const toolTypeById = new Map();

  tvApi.getLastActivity = () => lastActivity;

  function normalizeSymbol(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function emitAction(event, payload) {
    if (servicesApi.actionBus && typeof servicesApi.actionBus.emit === 'function') {
      servicesApi.actionBus.emit(event, payload);
    }
  }


  let cfg = {};
  try {
    cfg = loadConfig('../services/tvListener/config/tv-listener.json');
  } catch {
    cfg = {};
  }
  const tvProxy = servicesApi.tvProxy;
  if (tvProxy && typeof tvProxy.addListener === 'function') {
    tvProxy.addListener((rec) => {
      if (cfg.enabled === false) return;
      if (cfg.webhook?.enabled === true && rec?.event === 'message' && typeof rec.text === 'string' && rec.text.includes('@ATR')) {
        let webhookUrl = typeof cfg.webhook.url === 'string' ? cfg.webhook.url : null;
        if (!webhookUrl) {
          const port = intVal(cfg.webhook.port);
          if (port) webhookUrl = `http://localhost:${port}/webhook`;
        }
        if (webhookUrl) {
          fetch(webhookUrl, {
            method: 'POST',
            body: rec.text,
            headers: { 'content-type': 'text/plain' }
          }).catch(() => {});
        }
        return;
      }
      if (!rec || rec.event !== 'http_request' || typeof rec.text !== 'string') return;
      try {
        const payload = JSON.parse(rec.text);
        const sources = payload?.sources;
        if (!sources || typeof sources !== 'object') return;

        Object.entries(sources).forEach(([sourceId, src]) => {
          const sourceKey = sourceId != null && sourceId !== '' ? String(sourceId) : null;
          if (src && src.state?.type === 'LineToolHorzLine') {
            const symbol = normalizeSymbol(src.symbol);
            const price = Number(src.state?.points?.[0]?.price);
            if (symbol && Number.isFinite(price)) {
              const payload = { symbol, price, toolType: 'LineToolHorzLine' };
              if (sourceKey) payload.lineId = sourceKey;
              if (Number.isFinite(Number(src.serverUpdateTime))) payload.serverUpdateTime = Number(src.serverUpdateTime);
              if (sourceKey) toolTypeById.set(sourceKey, { type: 'line' });
              lastActivity = { symbol, price };
              if (sourceKey) lastActivity.lineId = sourceKey;
              emitAction('tv-tool-horzline', payload);
            }
          } else if (src && src.state?.type === 'LineToolHorzRay') {
            const symbol = normalizeSymbol(src.symbol);
            const rayPrice = Number(src.state?.points?.[0]?.price);
            if (symbol && Number.isFinite(rayPrice)) {
              const payload = { symbol, rayPrice, price: rayPrice, toolType: 'LineToolHorzRay' };
              if (sourceKey) payload.rayId = sourceKey;
              if (Number.isFinite(Number(src.serverUpdateTime))) payload.serverUpdateTime = Number(src.serverUpdateTime);
              if (sourceKey) toolTypeById.set(sourceKey, { type: 'ray' });
              emitAction('tv-tool-horzray', payload);
            }
          } else if (src === null && sourceKey) {
            const known = toolTypeById.get(sourceKey);
            if (known?.type === 'ray') {
              toolTypeById.delete(sourceKey);
              emitAction('tv-tool-horzray-remove', { rayId: sourceKey });
            } else {
              toolTypeById.delete(sourceKey);
              emitAction('tv-tool-horzline-remove', { lineId: sourceKey });
            }
          }
        });
      } catch {}
    });

  }

  class LastCommand extends AddCommand {
    constructor() {
      super();
      this.names = ['last', 'l'];
      this.name = this.names[0];
    }
    run(args) {
      if (!lastActivity) return { ok: false, error: 'No last activity' };
      const [slStr, tpStr, riskStr] = args;
      const { symbol, price, lineId } = lastActivity;
      const ticker = typeof symbol === 'string' && symbol.includes(':') ? symbol.split(':')[1] : symbol;
      const hasLine = typeof lineId === 'string' && lineId !== '';
      const prevOnAdd = this.onAdd;
      if (hasLine) {
        const producingLineId = lineId;
        this.onAdd = (row) => {
          row.producingLineId = producingLineId;
          if (typeof prevOnAdd === 'function') prevOnAdd(row);
        };
      }
      try {
        return super.run([ticker, price, slStr, tpStr, riskStr]);
      } finally {
        this.onAdd = prevOnAdd;
      }
    }
  }

  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  const lastCommand = new LastCommand();
  if (cfg.enabled !== false) servicesApi.commands.push(lastCommand);
  settings.onApply('tv-listener', ({ config }) => {
    cfg = config || {};
    for (let i = servicesApi.commands.length - 1; i >= 0; i -= 1) {
      if (servicesApi.commands[i]?.constructor?.name === 'LastCommand') servicesApi.commands.splice(i, 1);
    }
    const commands = cfg.enabled === false ? [] : [lastCommand];
    servicesApi.commands.push(...commands);
    servicesApi.commandLine?.replaceCommands?.(
      command => command?.constructor?.name === 'LastCommand',
      commands
    );
  });
}

module.exports = { initService, registerActionFunctions };
