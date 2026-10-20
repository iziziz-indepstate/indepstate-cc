// Use an isolated TV calendar with the instrument timezone, not the display
// timezone. No chart setting, live builder or history subscription is changed.
function candleWindowReader(api, info) {
  try {
    const base = api._prepareEndOfPeriodArgs().barBuilder;
    const prototype = base._session || base._sessionTgt;
    const session = new prototype.constructor(info.timezone, info.session, info.session_holidays, info.corrections);
    const intraday = !!base._session;
    const builder = intraday ? new base.constructor(base._periodSec, session) :
      new base.constructor(session, session, base._period, base._builder, false);
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: info.timezone, year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    function calendarToUtc(wall) {
      let utc = wall;
      for (let attempt = 0; attempt < 3; attempt++) {
        const part = Object.fromEntries(formatter.formatToParts(utc).map(item => [item.type, item.value]));
        const represented = Date.UTC(+part.year, +part.month - 1, +part.day, +part.hour, +part.minute, +part.second);
        const delta = wall - represented;
        if (!delta) return utc / 1000;
        utc += delta;
      }
      throw Error('Ambiguous TV session boundary');
    }
    return time => {
      try {
        builder.moveTo(time * 1000);
        const index = builder.indexOfBar(time * 1000);
        if (index < 0 || builder.startOfBar(index) !== time * 1000) return null;
        const end = intraday ? builder.endOfBar(index) / 1000 : calendarToUtc(
          session.spec.bordersOfDailyBar(builder.currentRange().to.toCalendar(session.spec.timezoneObj())).to.getTime() + 1000);
        return Number.isSafeInteger(end) && end > time && end - time <= 32 * 86400
          && time % 60 === 0 && end % 60 === 0 ? end : null;
      } catch { return null; }
    };
  } catch { return () => null; }
}

// Read only: never change chart, drawings, history subscriptions or order cards.
function snapshotCandlePage(makeWindowReader = candleWindowReader, options = {}) {
  const symbols = new Set(Array.isArray(options.sources) ? options.sources.slice(0, 32)
    : ['CAPITALCOM:NAS100', 'SPREADEX:SPX', 'CAPITALCOM:US500']);
  const collection = window._exposed_chartWidgetCollection;
  if (!collection?.getAll || collection.readOnly?.()) return { sources: [], series: [] };
  const sources = [], series = [], panels = [], needed = new Map();
  const selective = options.selective === true;
  const period = value => {
    const raw = String(value || '').toUpperCase();
    const aliases = { D: 'D1', '1D': 'D1', W: 'W1', '1W': 'W1', M: 'MN1', '1M': 'MN1' };
    if (aliases[raw]) return aliases[raw];
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if ([1,2,3,4,5,6,10,12,15,20,30].includes(n)) return 'M' + n;
      if ([1,2,3,4,6,8,12].includes(n / 60)) return 'H' + n / 60;
    }
    return /^(?:M(?:1|2|3|4|5|6|10|12|15|20|30)|H(?:1|2|3|4|6|8|12)|D1|W1|MN1)$/.test(raw) ? raw : null;
  };
  let anchorCount = 0;
  const addAnchor = (symbol, interval, time) => {
    const tf = period(interval), stamp = Number(time);
    if (!symbols.has(symbol) || !tf || !Number.isSafeInteger(stamp) || stamp <= 0) return;
    const key = symbol + '|' + tf;
    if (!needed.has(key)) needed.set(key, new Set());
    const times = needed.get(key);
    if (!times.has(stamp) && anchorCount < 4000) { times.add(stamp); anchorCount++; }
  };
  for (const anchor of (Array.isArray(options.anchors) ? options.anchors : []).slice(0, 2000)) {
    if (anchor) addAnchor(anchor.symbol, anchor.interval, anchor.time);
  }
  for (const [widgetIndex, widget] of collection.getAll().slice(0, 16).entries()) {
    const model = widget.model?.(), main = model?.mainSeries?.();
    const symbol = main?.symbol?.();
    if (!symbols.has(symbol) || main.isLoading()) continue;
    const interval = String(main.interval());
    panels.push({ widget, widgetIndex, main, symbol, interval });
    for (const source of model.dataSources().slice(0, 4000)) {
      // Saved line tools expose a server timestamp; studies have a different state API.
      if (typeof source.serverUpdateTime !== 'function' || source.isLoading?.()) continue;
      const version = source.serverUpdateTime();
      if (!Number.isFinite(version) || version <= 0) continue;
      const state = source.state();
      if (!['LineToolHorzLine', 'LineToolHorzRay'].includes(state?.type) || state.state?.symbol !== symbol) continue;
      sources.push([source.id(), { symbol, serverUpdateTime: version, state: {
        type: state.type, points: (state.points || []).slice(0, 1).map(point => ({
          time_t: point.time_t, interval: point.interval, offset: point.offset, price: point.price
        })), state: { linecolor: state.state.linecolor, text: String(state.state.text || '').slice(0, 256) }
      } }]);
      const point = state.points?.[0];
      if (point && Number(point.offset || 0) === 0) addAnchor(symbol, point.interval, point.time_t);
      if (sources.length >= 2000) break;
    }
    if (sources.length >= 2000) break;
  }
  for (const { widget, widgetIndex, main, symbol, interval } of panels) {
    const wanted = needed.get(symbol + '|' + period(interval)) || new Set();
    const values = [], windows = [];
    if (!selective || wanted.size) {
      const bars = main.bars(), first = bars.firstIndex(), last = bars.lastIndex();
      if (Number.isSafeInteger(first) && Number.isSafeInteger(last) && last >= first) {
        const begin = Math.max(first, last - 9999);
        if (!selective) {
          for (let index = begin; index <= last; index++) {
            const value = bars.valueAt(index);
            if (Array.isArray(value) && value.slice(0, 4).every(Number.isFinite)) values.push([value[0], value[2], value[3]]);
          }
        } else {
          const read = new Map(); let byTime;
          const at = index => {
            if (!read.has(index)) {
              const raw = bars.valueAt(index);
              read.set(index, Array.isArray(raw) && raw.length >= 4 && raw.slice(0, 4).every(Number.isFinite)
                ? [raw[0], raw[2], raw[3]] : null);
            }
            return read.get(index);
          };
          const buildIndex = () => {
            if (!byTime) {
              byTime = new Map();
              for (let index = begin; index <= last; index++) {
                const row = at(index); if (row) byTime.set(row[0], row);
              }
            }
            return byTime;
          };
          const exact = stamp => {
            if (byTime) return byTime.get(stamp);
            const left = at(begin), right = at(last);
            if (!left || !right || left[0] > right[0]) return buildIndex().get(stamp);
            if (stamp < left[0] || stamp > right[0]) return null;
            let lo = begin, hi = last, found;
            while (lo <= hi) {
              const middle = lo + Math.floor((hi - lo) / 2), row = at(middle);
              if (!row) return buildIndex().get(stamp);
              if (row[0] <= stamp) { if (row[0] === stamp) found = row; lo = middle + 1; }
              else hi = middle - 1;
            }
            return found || buildIndex().get(stamp);
          };
          if (wanted.size > 32 && wanted.size * 16 >= last - begin + 1) buildIndex();
          for (const stamp of wanted) { const row = exact(stamp); if (row) values.push(row); }
          values.sort((a, b) => a[0] - b[0]);
        }
      }
    }
    series.push({ event: 'candle_bars', symbol, interval, bars: values, windows });
    const api = wanted.size && window.TradingViewApi?.chart?.(widgetIndex);
    if (api?._chartWidget === widget) {
      const readEnd = makeWindowReader(api, main.symbolInfo());
      const byTime = selective ? new Map(values.map(value => [value[0], value])) : null;
      // Pending local records precede saved chart points. Preserve that order
      // within the existing 2000-window receive limit after a large local edit.
      const windowRows = selective ? [...wanted].map(time => byTime.get(time)).filter(Boolean).slice(0, 2000) : values;
      for (const value of windowRows) if (wanted.has(value[0])) {
        const end = readEnd(value[0]);
        if (end) windows.push([value[0], end]);
      }
    }
  }
  const snapshot = { sources, series };
  if (!selective) return snapshot;
  const signature = JSON.stringify(snapshot);
  const state = window.__isccAddonCandleSnapshot ||= { generation: Date.now() + '-' + Math.random(), revision: 0, signature: '' };
  if (state.signature !== signature) { state.signature = signature; state.revision++; }
  const token = state.generation + ':' + state.revision;
  return options.ack === token ? { unchanged: true, token } : { ...snapshot, token };
}

module.exports = { snapshotCandlePage, candleWindowReader };
