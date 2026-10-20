const { createHash } = require('crypto');

const { DEFAULT_SOURCES, sourceMap, brokerName } = require('./candle-mappings');
const GROUP_KEYS = { USTEC: 'TV → MT5 · USTEC', SPX500: 'TV → MT5 · SPX500' };
const OWNER = 'tv-mt5-candles';

function timeframe(value) {
  const raw = String(value || '').toUpperCase();
  const minutes = { '1': 'M1', '2': 'M2', '3': 'M3', '4': 'M4', '5': 'M5', '6': 'M6',
    '10': 'M10', '12': 'M12', '15': 'M15', '20': 'M20', '30': 'M30', '60': 'H1',
    '120': 'H2', '180': 'H3', '240': 'H4', '360': 'H6', '480': 'H8', '720': 'H12',
    D: 'D1', '1D': 'D1', W: 'W1', '1W': 'W1', M: 'MN1', '1M': 'MN1' };
  return minutes[raw] || (/^(?:M(?:1|2|3|4|5|6|10|12|15|20|30)|H(?:1|2|3|4|6|8|12)|D1|W1|MN1)$/.test(raw) ? raw : null);
}

function colorRgb(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 80) throw Error('Некорректный цвет линии ТВ');
  const text = value.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(text);
  if (hex) {
    const rgb = hex[1].length <= 4 ? [...hex[1].slice(0, 3)].map(x => x + x).join('') : hex[1].slice(0, 6);
    return parseInt(rgb, 16);
  }
  const css = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/i.exec(text);
  if (css) {
    const channels = css.slice(1, 4).map(Number);
    if (channels.every(x => x <= 255)) return channels[0] * 65536 + channels[1] * 256 + channels[2];
  }
  throw Error('Неподдерживаемый цвет линии ТВ');
}

function drawing(sourceId, source, config = {}) {
  const symbol = sourceMap(config)[String(source?.symbol || '').toUpperCase()];
  if (!symbol) return null;
  const state = source.state || {}, point = state.points?.[0];
  if (!['LineToolHorzLine', 'LineToolHorzRay'].includes(state.type)) return null;
  if (String(state.state?.text || '').startsWith('ISCC STOCKS | ')) return null;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(String(sourceId))) throw Error('Некорректный идентификатор линии ТВ');
  const tf = timeframe(point?.interval), time = Number(point?.time_t);
  const price = Number(point?.price);
  const rgb = colorRgb(state.state?.linecolor);
  if (!tf || !Number.isSafeInteger(time) || time <= 0 || !Number.isFinite(price) || price <= 0
    || Number(point?.offset || 0) !== 0) throw Error('У линии нет точной привязки к свече и таймфрейму');
  return { id: createHash('sha256').update('tv-candle:' + sourceId).digest('hex').slice(0, 24),
    sourceId, sourceSymbol: source.symbol.toUpperCase(), symbol, timeframe: tf, time, sourcePrice: price,
    tool: state.type === 'LineToolHorzLine' ? 'line' : 'ray', ...(rgb == null ? {} : { colorRgb: rgb }) };
}

function selectExtreme(marker, bar) {
  if (!bar || bar[0] !== marker.time || !bar.slice(1).every(Number.isFinite) || bar[1] < bar[2]) return null;
  const epsilon = Math.max(1e-8, Math.abs(marker.sourcePrice) * 1e-11);
  const high = Math.abs(marker.sourcePrice - bar[1]) <= epsilon;
  const low = Math.abs(marker.sourcePrice - bar[2]) <= epsilon;
  if (high && low) throw Error('High и Low этой свечи совпадают: сторона уровня неоднозначна');
  if (!high && !low) throw Error('Линия должна стоять точно на High или Low исходной свечи ТВ');
  return high ? 'high' : 'low';
}

function candleKey(symbol, tf, time) { return `${symbol}|${tf}|${time}`; }

class CandleLevelSync {
  constructor({ getConfig = () => ({}), getAdapter, publish = async () => {}, persist = async () => {},
    initial = {}, onStatus = () => {}, onNeedBars = () => {}, clock = Date.now } = {}) {
    this.getConfig = getConfig; this.getAdapter = getAdapter; this.publish = publish;
    this.persist = persist; this.onStatus = onStatus; this.onNeedBars = onNeedBars; this.clock = clock;
    this.records = new Map(); this.bars = new Map(); this.busy = false; this.closed = false;
    this.dirty = false; this.publishNeeded = false; this.lastError = null;
    this.networkFailures = 0; this.networkRetryAt = 0; this.mappingSignature = null;
    for (const row of initial.records || []) {
      if (row && /^[a-f0-9]{24}$/.test(row.id || '') && /^[A-Za-z0-9_.:-]{1,160}$/.test(row.sourceId || '')
        && Number.isSafeInteger(row.revision) && row.revision > 0) {
        const migrate = !row.removed && !row.windowed;
        const phase = row.removed || (row.side && row.endTime) ? 'queued' :
          !row.timeframe || (row.phase === 'error' && !row.selectionError) ? 'error' : 'awaiting-tv';
        this.records.set(row.sourceId, { ...row, phase, windowed: true,
          ...(migrate ? { revision: row.revision + 1, retire: true, price: null } : {}) });
      }
    }
    this.publishNeeded = this.records.size > 0;
  }

  enabled() { return !this.closed && this.getConfig().enabled !== false; }
  reconfigure() {
    const map = sourceMap(this.getConfig()), signature = JSON.stringify(map);
    if (signature === this.mappingSignature) return;
    const initial = this.mappingSignature === null;
    let changed = false;
    this.mappingSignature = signature;
    for (const [sourceId, old] of this.records) {
      if (!old.sourceSymbol || (old.removed && !old.mappingDisabled)) continue;
      const target = map[old.sourceSymbol];
      if (target === old.symbol && !old.mappingDisabled) continue;
      if (!target && old.mappingDisabled) continue;
      const row = { ...old, symbol: target || old.symbol, mappingDisabled: !target, removed: !target,
        revision: old.revision + 1, price: null, retire: true, phase: target && (!old.side || !old.endTime) ? 'awaiting-tv' : 'queued',
        reason: null, nextAttemptAt: 0, requestRetryAt: 0, requestFailures: 0, requestError: null };
      if (target) {
        const marker = Object.fromEntries(['id','sourceId','sourceSymbol','symbol','timeframe','time','sourcePrice','tool','colorRgb']
          .filter(key => row[key] != null).map(key => [key, row[key]]));
        row.signature = JSON.stringify(marker);
        if (row.phase === 'awaiting-tv') this.identify(row);
      }
      this.records.set(sourceId, row); this.dirty = true; changed = true;
    }
    this.publishNeeded = true;
    if (!initial || changed) this.onNeedBars();
  }
  requiredBars() {
    return [...this.records.values()].filter(row => !row.removed && row.sourceSymbol && row.timeframe
      && Number.isSafeInteger(row.time) && row.time > 0)
      .map(row => ({ symbol: row.sourceSymbol, interval: row.timeframe, time: row.time }));
  }
  acceptSnapshot(snapshot) {
    if (!this.enabled() || !snapshot || !Array.isArray(snapshot.sources) || !Array.isArray(snapshot.series)) return;
    this.reconfigure();
    for (const series of snapshot.series.slice(0, 16)) this.acceptBars(series);
    for (const entry of snapshot.sources.slice(0, 2000)) {
      if (!Array.isArray(entry) || entry.length !== 2 || !entry[1]
        || !Number.isFinite(entry[1].serverUpdateTime) || entry[1].serverUpdateTime <= 0) continue;
      this.acceptSource(entry[0], entry[1]);
    }
  }
  serialize() { return { schema: 1, records: [...this.records.values()].map(row => ({ ...row })) }; }
  status() {
    const all = [...this.records.values()], rows = all.filter(row => !row.removed);
    const removals = all.filter(row => row.removed && row.phase !== 'removed');
    return { enabled: this.enabled(), ready: rows.filter(row => row.phase === 'ready').length,
      pending: rows.filter(row => !['ready', 'error'].includes(row.phase)).length + removals.length,
      pendingRemovals: removals.length,
      errors: all.filter(row => (!row.removed && row.phase === 'error') || row.requestError).length,
      reason: this.lastError || all.find(row => row.requestError)?.requestError
        || all.find(row => row.reason && (!row.removed || row.phase === 'deleting'))?.reason || null };
  }

  acceptSource(sourceId, source, { local = false } = {}) {
    if (!this.enabled() || !sourceId) return false;
    this.reconfigure();
    const old = this.records.get(sourceId);
    const mapped = source && sourceMap(this.getConfig())[String(source.symbol || '').toUpperCase()];
    if (!mapped && !old) return false;
    if (source && !['LineToolHorzLine', 'LineToolHorzRay'].includes(source.state?.type) && !old) return false;
    const version = Number(source?.serverUpdateTime) || 0;
    // Outgoing PUTs are ordered local edits. Their embedded server timestamp
    // describes the last saved copy and must not veto a subsequent drag.
    if (!local && old && version && old.sourceVersion
      && (version < old.sourceVersion || (old.localEdit && version === old.sourceVersion))) return true;
    let marker, reason;
    const config = !mapped && old?.sourceSymbol ? { mappings: [{ enabled: true, sourceSymbol: old.sourceSymbol, mt5Symbol: old.symbol }] } : this.getConfig();
    try { marker = source && drawing(sourceId, source, config); } catch (error) { reason = error.message; }
    const mappingDisabled = !!marker && !mapped && !!old?.sourceSymbol;
    const sameCandle = marker && old && !old.removed && ['high', 'low'].includes(old.side)
      && ['sourceSymbol', 'symbol', 'timeframe', 'time', 'sourcePrice', 'tool'].every(key => marker[key] === old[key]);
    const signature = JSON.stringify(marker || { removed: !source, reason });
    if (old?.signature === signature) {
      if (version > (old.sourceVersion || 0)) {
        old.sourceVersion = version; old.localEdit = local; this.dirty = true;
      }
      return true;
    }
    if (!old && this.records.size >= 2000) { this.lastError = 'Достигнут предел свечных отметок'; this.onStatus(this.status()); return true; }
    const row = { ...(old || {}), ...(marker || {}), sourceId,
      id: marker?.id || old?.id || createHash('sha256').update('tv-candle:' + sourceId).digest('hex').slice(0, 24),
      revision: (old?.revision || 0) + 1, sourceVersion: Math.max(version, old?.sourceVersion || 0), localEdit: local, signature,
      side: sameCandle ? old.side : null, endTime: sameCandle ? old.endTime : null,
      windowed: true, price: null, removed: mappingDisabled || !source || (!marker && !reason), mappingDisabled,
      phase: reason ? 'error' : marker && (!sameCandle || !old.endTime) ? 'awaiting-tv' : 'queued', reason: reason || null,
      retire: !!old && !old.removed, nextAttemptAt: 0,
      selectionError: false, requestFailures: 0, requestRetryAt: 0, requestError: null };
    if (marker && (!sameCandle || !old.endTime)) this.identify(row);
    if (mappingDisabled) { row.phase = 'queued'; row.reason = null; }
    this.records.set(sourceId, row); this.dirty = true; this.publishNeeded = true;
    if (marker && row.phase === 'awaiting-tv') this.onNeedBars();
    this.onStatus(this.status());
    return true;
  }

  identify(row) {
    const bar = this.bars.get(candleKey(row.sourceSymbol, row.timeframe, row.time));
    if (!bar) { row.reason = `Ожидание данных исходной свечи ТВ (${row.timeframe})`; return; }
    try {
      row.side = selectExtreme(row, bar); row.endTime = bar[3] || row.endTime;
      row.phase = row.side && row.endTime ? 'queued' : 'awaiting-tv';
      row.reason = row.endTime ? null : `Ожидание точных границ исходной свечи ТВ (${row.timeframe})`;
      row.selectionError = false;
    }
    catch (error) { row.phase = 'error'; row.reason = error.message; row.selectionError = true; }
  }

  acceptBars(record) {
    if (!this.enabled() || record?.event !== 'candle_bars' || !sourceMap(this.getConfig())[record.symbol]) return;
    this.reconfigure();
    const tf = timeframe(record.interval);
    if (!tf || !Array.isArray(record.bars) || record.bars.length > 10000) return;
    for (const row of record.bars) {
      if (!Array.isArray(row) || row.length !== 3 || !row.every(Number.isFinite)
        || !Number.isSafeInteger(row[0]) || row[1] <= 0 || row[2] <= 0 || row[1] < row[2]) continue;
      const key = candleKey(record.symbol, tf, row[0]);
      const end = this.bars.get(key)?.[3];
      this.bars.delete(key); this.bars.set(key, end ? [...row, end] : row.slice());
    }
    for (const window of (Array.isArray(record.windows) ? record.windows : []).slice(0, 2000)) {
      if (!Array.isArray(window) || window.length !== 2 || !window.every(Number.isSafeInteger)
        || window[0] <= 0 || window[1] <= window[0] || window[1] - window[0] > 32 * 86400
        || window.some(value => value % 60)) continue;
      const bar = this.bars.get(candleKey(record.symbol, tf, window[0]));
      if (bar) bar[3] = window[1];
    }
    while (this.bars.size > 20000) this.bars.delete(this.bars.keys().next().value);
    for (const row of this.records.values()) {
      const end = this.bars.get(candleKey(row.sourceSymbol, row.timeframe, row.time))?.[3];
      if ((row.phase !== 'awaiting-tv' && !row.selectionError && (!end || end === row.endTime))
        || row.removed || row.sourceSymbol !== record.symbol || row.timeframe !== tf) continue;
      const previous = [row.phase, row.side, row.reason, row.endTime].join('|');
      this.identify(row);
      if (previous !== [row.phase, row.side, row.reason, row.endTime].join('|')) {
        row.revision++; row.nextAttemptAt = 0; row.requestRetryAt = 0; this.dirty = true;
        row.price = null; this.publishNeeded = true;
      }
    }
  }

  async save() {
    if (!this.dirty) return;
    const state = this.serialize(); this.dirty = false;
    try { await this.persist(state); } catch (error) { this.dirty = true; throw error; }
  }

  currentLevels() {
    const levels = {};
    for (const row of this.records.values()) {
      try { brokerName(row.symbol); } catch { continue; }
      levels[row.symbol] ||= [];
      if (!row.removed && row.phase === 'ready' && Number.isFinite(row.price) && row.price > 0) levels[row.symbol].push(row.price);
    }
    return Object.fromEntries(Object.entries(levels).map(([symbol, prices]) => [symbol, [...new Set(prices)].sort((a, b) => a - b)]));
  }

  async publishCurrent() {
    if (!this.publishNeeded) return;
    this.publishNeeded = false;
    try {
      await this.publish(this.currentLevels(), () => this.currentLevels());
    } catch (error) { this.publishNeeded = true; throw error; }
  }

  acceptReply(state) {
    if (!state || !Array.isArray(state.levels)) throw Error('Некорректный ответ свечных уровней MT5');
    for (const row of this.records.values()) {
      if (row.removed && row.phase === 'deleting') {
        if (state.snapshotApplied === true && !state.levels.some(remote => remote.id === row.id)) {
          row.phase = 'removed'; row.reason = null; this.dirty = true;
        }
        continue;
      }
      if (!['drawing', 'queued', 'waiting-close', 'waiting-history'].includes(row.phase) || row.removed || !row.side) continue;
      const remote = state.levels.find(item => item.id === row.id && item.revision === row.revision);
      if (!remote) continue;
      if (remote.status === 'ready' && remote.symbol === row.brokerSymbol && remote.time === row.time
        && remote.timeframe === row.timeframe && remote.endTime === row.endTime && remote.side === row.side && remote.tool === row.tool
        && (row.colorRgb == null || remote.colorRgb === row.colorRgb)
        && Number.isFinite(remote.price) && remote.price > 0) {
        row.price = remote.price; row.phase = 'ready'; row.reason = null;
        this.dirty = true; this.publishNeeded = true;
      } else if (['waiting-close', 'waiting-history'].includes(remote.status)) {
        row.phase = remote.status; row.nextAttemptAt = Math.max(this.clock() + 1000, Number(remote.retryAt) || 0);
        row.reason = remote.status === 'waiting-close' ? 'Ожидание закрытия выбранной свечи MT5' : 'MT5 загружает историю выбранной свечи'; this.dirty = true;
      } else if (remote.status === 'error') {
        row.phase = 'error'; row.reason = remote.reason || 'Свеча MT5 недоступна'; this.dirty = true;
      } else { row.phase = 'drawing'; row.reason = remote.reason || 'Ожидание отрисовки уровня в MT5'; }
    }
  }

  async tick() {
    if (!this.enabled() || this.busy) return;
    this.busy = true;
    try {
      this.reconfigure();
      await this.save(); await this.publishCurrent();
      if (this.networkRetryAt > this.clock()) return;
      const work = [...this.records.values()].filter(row => (row.requestRetryAt || 0) <= this.clock()
        && (row.retire || row.phase === 'queued'
        || (['waiting-close', 'waiting-history'].includes(row.phase) && row.nextAttemptAt <= this.clock())))
        .sort((left, right) => Number(right.removed) - Number(left.removed)).slice(0, 4);
      const pendingDrawing = [...this.records.values()].some(row => ['drawing', 'deleting'].includes(row.phase));
      if (!work.length && !pendingDrawing) return;
      const adapter = this.getAdapter();
      if (!adapter.capabilities?.includes('candle-levels')) {
        await adapter.health();
        if (!adapter.capabilities?.includes('candle-levels')) throw Error('Нужно обновить приёмник свечных уровней на VPS');
      }
      let checkedColor = false;
      for (const row of work) {
        if (this.closed || !this.enabled()) break;
        const revision = row.revision;
        try {
          const remove = row.removed || !row.side || !row.endTime || row.phase === 'error';
          const payload = { id: row.id, revision, action: remove ? 'delete' : 'upsert' };
          if (!remove) {
            if (!adapter.capabilities?.includes('candle-levels-window')) {
              await adapter.health();
              if (!adapter.capabilities?.includes('candle-levels-window')) throw Error('Нужно обновить приёмник точных интервалов свечей на VPS');
            }
            if (row.colorRgb != null && !adapter.capabilities?.includes('candle-levels-color')) {
              if (!checkedColor) { checkedColor = true; await adapter.health(); }
              if (!adapter.capabilities?.includes('candle-levels-color')) throw Error('Нужно обновить приёмник цветов свечных уровней на VPS');
            }
            row.brokerSymbol = adapter.candleSymbol ? adapter.candleSymbol(row.symbol) : adapter.brokerSymbol(row.symbol);
            Object.assign(payload, { symbol: row.brokerSymbol, timeframe: row.timeframe,
              time: row.time, endTime: row.endTime, side: row.side, tool: row.tool,
              ...(row.colorRgb == null ? {} : { colorRgb: row.colorRgb }) });
          }
          await this.save();
          if (row !== this.records.get(row.sourceId) || row.revision !== revision || !this.enabled()) continue;
          const reply = await adapter.request('/candle-levels', payload);
          if (row !== this.records.get(row.sourceId) || row.revision !== revision || !this.enabled()) continue;
          if (!Array.isArray(reply?.candleLevels?.levels)) throw Error('Некорректный ответ свечных уровней MT5');
          row.retire = false; row.requestFailures = 0; row.requestRetryAt = 0; row.requestError = null;
          if (remove) {
            if (row.removed) {
              row.phase = typeof reply.candleLevels.snapshotApplied === 'boolean' ? 'deleting' : 'removed';
              row.reason = row.phase === 'deleting' ? 'Ожидание удаления уровня в MT5' : null;
            }
          }
          else row.phase = 'drawing';
          this.acceptReply(reply.candleLevels); this.dirty = true;
        } catch (error) {
          if (row !== this.records.get(row.sourceId) || row.revision !== revision) continue;
          row.requestError = String(error.message || error);
          row.requestRetryAt = this.clock() + Math.min(30000, 1000 * 2 ** Math.min((row.requestFailures || 0) + 1, 5));
          row.requestFailures = (row.requestFailures || 0) + 1; this.dirty = true;
        }
      }
      if ([...this.records.values()].some(row => ['drawing', 'deleting'].includes(row.phase))) {
        const reply = await adapter.request('/candle-levels');
        if (this.enabled()) this.acceptReply(reply.candleLevels);
      }
      this.lastError = null;
      this.networkFailures = 0; this.networkRetryAt = 0;
      await this.save(); await this.publishCurrent();
    } catch (error) {
      this.lastError = String(error.message || error);
      this.networkRetryAt = this.clock() + Math.min(30000, 1000 * 2 ** Math.min(++this.networkFailures, 5));
    }
    finally { this.busy = false; this.onStatus(this.status()); }
  }

  start() { this.timer = setInterval(() => this.tick(), 1000); this.timer.unref?.(); return this; }
  stop() { this.closed = true; clearInterval(this.timer); }
}

function updateManagedLevels(config, levels) {
  const groups = config.groups.map(group => ({ ...group, levels: group.levels.slice() }));
  for (const group of groups) if (group.source === OWNER) group.levels = levels[group.ticker] || [];
  for (const [symbol, prices] of Object.entries(levels)) {
    try { brokerName(symbol); } catch { continue; }
    const key = GROUP_KEYS[symbol] || `TV → MT5 · ${symbol}`;
    const current = groups.find(group => group.source === OWNER && group.ticker === symbol);
    if (current) current.levels = prices;
    else if (prices.length) {
      const reference = groups.find(group => group.ticker === symbol && Number.isFinite(group.maxOffset));
      let unique = key, suffix = 2;
      while (groups.some(group => group.key === unique)) unique = `${key} (${suffix++})`;
      groups.push({ key: unique, source: OWNER, ticker: symbol, levels: prices, enabled: true, maxOffset: reference?.maxOffset ?? 0 });
    }
  }
  return { ...config, groups };
}

module.exports = { CandleLevelSync, drawing, selectExtreme, timeframe, colorRgb, DEFAULT_SOURCES, GROUP_KEYS, OWNER, updateManagedLevels };
