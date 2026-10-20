'use strict';
const { spawn } = require('child_process');
const CAPABILITIES = ['candle-levels', 'candle-levels-window', 'candle-levels-color'];

function readOnlyAdapter(adapter) {
  if (!adapter || typeof adapter.request !== 'function') throw Error('Приёмник свечных уровней MT5 не настроен');
  return {
    get capabilities() { return adapter.capabilities || []; },
    health: () => adapter.health(),
    candleSymbol: symbol => adapter.candleSymbol ? adapter.candleSymbol(symbol) : adapter.brokerSymbol(symbol),
    request(route, payload) {
      if (route !== '/candle-levels') throw Error('Разрешён только обмен свечными уровнями');
      return adapter.request(route, payload);
    }
  };
}

// The command belongs to the recipient's private local settings, never to a
// downloaded selection plan. shell:false keeps arguments as literal arguments.
class StdioAdapter {
  constructor(command, { spawnProcess = spawn, timeoutMs = 25000 } = {}) {
    if (!Array.isArray(command) || !command.length || command.length > 24
      || command.some(value => typeof value !== 'string' || !value || /[\r\n\0]/.test(value)))
      throw Error('Задайте локальную команду приёмника как массив программы и аргументов');
    this.pending = new Map(); this.buffer = ''; this.sequence = 0; this.timeoutMs = timeoutMs;
    this.capabilities = []; this.closed = false;
    this.child = spawnProcess(command[0], command.slice(1), { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', data => this.receive(data));
    this.child.stderr.resume(); // No terminal identities or private paths go into public logs.
    this.child.on('error', () => this.fail(Error('Не удалось запустить локальный приёмник MT5')));
    this.child.on('exit', () => this.fail(Error('Локальный приёмник MT5 остановлен')));
    this.child.stdin.on('error', () => this.fail(Error('Канал приёмника MT5 закрыт')));
  }
  fail(error) {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  receive(data) {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) { this.close(); return; }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let value;
      try { value = JSON.parse(line); } catch { this.close(); return; }
      if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.id)) { this.close(); return; }
      const pending = this.pending.get(value.id);
      if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(value.id);
      value.error ? pending.reject(Error('Приёмник MT5: ' + value.error)) : pending.resolve(value.result);
    }
  }
  call(route, payload) {
    if (this.closed) return Promise.reject(Error('Перезапустите отрисовщик после остановки приёмника'));
    if (this.pending.size >= 8) return Promise.reject(Error('Очередь чтения свечей заполнена'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Приёмник MT5 не ответил вовремя')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, route, ...(payload === undefined ? {} : { payload }) }) + '\n');
    });
  }
  async health() {
    const result = await this.call('/health');
    this.capabilities = CAPABILITIES.filter(value => result?.capabilities?.includes(value));
    return result;
  }
  candleSymbol(symbol) { return require('./candle-mappings').brokerName(symbol); }
  request(route, payload) {
    if (route !== '/candle-levels') return Promise.reject(Error('Разрешён только обмен свечными уровнями'));
    return this.call(route, payload);
  }
  close() { this.fail(Error('Отрисовщик остановлен')); this.child.kill(); }
}
module.exports = { readOnlyAdapter, StdioAdapter, CAPABILITIES };
