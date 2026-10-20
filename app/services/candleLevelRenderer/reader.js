'use strict';
const { snapshotCandlePage, candleWindowReader } = require('./page');
const { createHash } = require('crypto');

function localDebugger(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.port === '9222' && !url.username && !url.password;
  } catch { return false; }
}
function chart(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['tradingview.com', 'www.tradingview.com', 'ru.tradingview.com'].includes(url.hostname)
      && url.pathname.startsWith('/chart/') && !url.username && !url.password;
  } catch { return false; }
}
function evaluate(url, expression, { signal } = {}) {
  if (!localDebugger(url)) return Promise.reject(Error('Разрешён только локальный отладчик TradingView'));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('Чтение остановлено')); return; }
    const WebSocket = require('ws');
    const socket = new WebSocket(url, { maxPayload: 2 * 1024 * 1024 });
    let done = false;
    const abort = () => finish(Error('Чтение остановлено'));
    const timer = setTimeout(() => finish(Error('TradingView не ответил')), 20000);
    function finish(error, result) {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? socket.terminate() : socket.close();
      error ? reject(error) : resolve(result);
    }
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(Error('Нет связи с локальным TradingView')));
    socket.on('close', () => finish(Error('Соединение с TradingView закрыто')));
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } })));
    socket.on('message', bytes => {
      let value;
      try { value = JSON.parse(String(bytes)); } catch { finish(Error('Некорректный ответ TradingView')); return; }
      if (value.id !== 1) return;
      if (value.error || value.result?.exceptionDetails) finish(Error('Не удалось прочитать разметку TradingView'));
      else finish(null, value.result?.result?.value);
    });
  });
}
async function targets(signal) {
  const response = await require('node-fetch')('http://127.0.0.1:9222/json/list',
    { timeout: 1800, size: 1024 * 1024, redirect: 'error', signal });
  if (!response.ok) throw Error('Не удалось получить вкладки TradingView');
  const value = await response.json();
  if (!Array.isArray(value)) throw Error('Некорректный список вкладок TradingView');
  return value.filter(row => chart(row.url) && localDebugger(row.webSocketDebuggerUrl)).slice(0, 16);
}
function startReader({ enabled, acceptSnapshot, sources, anchors, onError = () => {},
  getTargets = targets, run = evaluate, intervalMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let closed = false, running = false, timer, controller;
  const active = () => !closed && enabled();
  const seen = new Map(), installed = new Set();
  const collector = snapshotCandlePage.toString(), calendar = candleWindowReader.toString();
  const version = JSON.stringify(createHash('sha256').update(collector).update(calendar).digest('hex'));
  function schedule(delay) { clearTimer(timer); if (!closed) { timer = setTimer(tick, delay); timer.unref?.(); } }
  async function tick() {
    if (closed || running) return;
    running = true; controller = new AbortController();
    try {
      if (!active()) { seen.clear(); installed.clear(); return; }
      const charts = await getTargets(controller.signal);
      for (const target of charts) {
        if (!active()) break;
        try {
        const options = JSON.stringify({ selective: true, sources: sources(), anchors: anchors(), ack: seen.get(target.id) });
        let result;
        if (installed.has(target.id)) result = await run(target.webSocketDebuggerUrl, `(() => {
          const runtime = window.__isccAddonCandleRuntime;
          if (runtime?.version !== ${version}) return { missingRuntime: true };
          return runtime.collect(runtime.calendar, ${options}); })()`, { signal: controller.signal });
        if (!installed.has(target.id) || result?.missingRuntime) {
          if (!active()) break;
          result = await run(target.webSocketDebuggerUrl, `(() => {
            const runtime = window.__isccAddonCandleRuntime = {
              version: ${version}, collect: (${collector}), calendar: (${calendar})
            };
            return runtime.collect(runtime.calendar, ${options}); })()`, { signal: controller.signal });
          installed.add(target.id);
        }
        if (!active()) break;
        if (result?.unchanged && result.token === seen.get(target.id)) continue;
        if (result && Array.isArray(result.sources) && Array.isArray(result.series)) {
          await acceptSnapshot(result); seen.set(target.id, result.token);
        }
        } catch (error) {
          seen.delete(target.id); installed.delete(target.id);
          if (active()) onError(error);
        }
      }
      for (const id of installed) if (!charts.some(target => target.id === id)) { seen.delete(id); installed.delete(id); }
    } catch (error) { if (active()) onError(error); }
    finally { running = false; controller = undefined; schedule(intervalMs); }
  }
  schedule(1000);
  return { refresh() { if (!running) schedule(250); }, stop() { closed = true; clearTimer(timer); controller?.abort(); seen.clear(); installed.clear(); } };
}
module.exports = { startReader, chart, localDebugger, evaluate };
