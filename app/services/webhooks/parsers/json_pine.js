// Pine bot JSON : {"symbol":"AXTI","direction":"short","type":"stop limit","qty":33,"sl":0.3,"tp":0.9,"slPrice":23.59,"tpPrice":22.39,"note":"1. Prime BR","stop":23.29,"limit":23.29,"entryPrice":23.29,"magic":2329099}
const {toPoints} = require("../../instrumentInfo/points");

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : undefined; }

module.exports = {
  name: 'json',
  test(raw) {
    if (typeof raw !== 'string') return false;
    const s = raw.trim();
    return s.startsWith('{') && s.endsWith('}') && s.includes("direction") && s.includes("symbol");
  },
  parse(raw, nowTs) {
    let js;
    try { js = JSON.parse(raw); } catch { return null; }
    const ticker = js.symbol || '';
    const event  = js.direction + ' ' + js.type ||  '' ;
    const price  = num(js.stop || js.limit || js.entryPrice);

    if (!ticker || !Number.isFinite(price)) return null;

    const stopNum = num(js.sl);
    const takeNum = num(js.tp);
    const qty = num(js.qty);
    const tick = num(js.meta.tick);
    const lot = num(js.meta.lot);
    const instrumentType = js.meta.instrumentType;


    // Переводим в пункты: приоритет tickSize из конфига, иначе цифровой fallback
    const sl = Number.isFinite(stopNum) ? toPoints(tick, ticker, stopNum, price, js.sl) : undefined;
    const tp = Number.isFinite(takeNum) ? toPoints(tick, ticker, takeNum, price, js.tp) : undefined;


    let row = {
      ticker, event, price, time: nowTs(),
      sl, tp, qty,
      tickSize: Number.isFinite(tick) ? tick : undefined,
      lot: Number.isFinite(lot) ? lot : undefined,
      instrumentType: instrumentType,
    };

    console.log(row);
    return {
      row: row
    };
  }
};
