// app/services/webhooks/parsers/atr.js
const { toPoints } = require('../../instrumentInfo/points');

const NUM = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const RE_NESTED = new RegExp(
  String.raw`@ATR\s*\(\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*\)[\s\S]*?\)\s*(?:Crossing|EP\sat)\s*(${NUM})\s*on\s*([^,\s]+)`,
  'i'
);

function numToType(typeNum){
  // make switch by typeNum
  // 1 - EQ, 2 - FX, 3 - CX, 0 - undefined
  if (!Number.isFinite(typeNum)) return undefined;
  switch (typeNum) {
    case 1: return 'EQ';
    case 2: return 'FX';
    case 3: return 'CX';
    default: return undefined;
  }
}

module.exports = {
  name: 'atr',
  test(raw) { return typeof raw === 'string' && raw.includes('@ATR') && RE_NESTED.test(raw); },
  parse(raw, nowTs) {
    const m = raw.match(RE_NESTED);
    if (!m) return null;

    // Сохраняем и числовое, и строковое представление
    const stopTok = m[1], takeTok = m[2], poseTok = m[3], tickTok = m[4], lotTok = m[5], typeTok = m[6], levelTok = m[7], ticker = String(m[8]);
    const stopNum = Number(stopTok);
    const takeNum = Number(takeTok);
    const poseNum = Number(poseTok);
    const tickNum = Number(tickTok);
    const lotNum = Number(lotTok);
    const typeNum = Number(typeTok);
    const level   = Number(levelTok);

    if (!ticker || !Number.isFinite(level)) return null;

    // Переводим в пункты: приоритет tickSize из конфига, иначе цифровой fallback
    const slPts = Number.isFinite(stopNum) ? toPoints(tickNum, ticker, stopNum, level, stopTok) : undefined;
    const tpPts = Number.isFinite(takeNum) ? toPoints(tickNum, ticker, takeNum, level, takeTok) : undefined;
    return {
      row: {
        ticker,
        event: 'ATR',
        price: level,
        time: nowTs(),
        sl: slPts,
        tp: tpPts,
        qty: Number.isFinite(poseNum) ? poseNum : undefined,
        tickSize: Number.isFinite(tickNum) ? tickNum : undefined,
        lot: Number.isFinite(lotNum) ? lotNum : undefined,
        instrumentType: numToType(typeNum),
        // для отладки при желании можно сохранять сырьё:
        // slRaw: stopTok, tpRaw: takeTok
      }
    };
  }
};
