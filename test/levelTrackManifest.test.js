const assert = require('assert');
const Module = require('module');

async function run() {
  const handlers = {};
  const messages = [];
  const windows = [];
  class BrowserWindow {
    constructor() {
      this.url = '';
      this.webContents = {
        getURL: () => this.url,
        send: (channel, data) => messages.push({ win: this, channel, data }),
        on() {}
      };
      windows.push(this);
    }
    isDestroyed() { return false; }
    on() {}
    loadFile(file) { this.url = file; }
    static getAllWindows() { return windows; }
  }
  const main = new BrowserWindow();
  main.url = 'file:///app/index.html';
  const unrelated = new BrowserWindow();
  unrelated.url = 'file:///app/settings.html';
  const destroyed = new BrowserWindow();
  destroyed.isDestroyed = () => true;
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow, ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } } };
    if (request === '../settings' && parent.filename.includes('levelTrack')) return {
      register() {}, onApply() {}, readConfig: () => ({ config: { refreshMs: 60000, groups: [] } })
    };
    return original(request, parent, isMain);
  };
  try {
    const { initService } = require('../app/services/levelTrack/manifest');
    const api = {};
    initService(api);
    api.commands[0].run();
    const tracker = windows.at(-1);
    api.levelTrack.configure({ groups: [{ key: 'spx', ticker: 'SPX', levels: [100], maxOffset: 2 }] });
    assert.deepStrictEqual(messages.map(message => message.win), [main, tracker]);
    assert(messages.every(message => message.channel === 'level-track:state'));
    assert.deepStrictEqual(handlers['level-track:list'](), api.levelTrack.snapshot());
    assert.strictEqual(messages[0].data.config.groups[0].key, 'spx');
  } finally {
    Module._load = original;
  }
  console.log('levelTrack manifest tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
