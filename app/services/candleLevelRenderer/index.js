'use strict';
const fs = require('fs');
const path = require('path');
const { CandleLevelSync, updateManagedLevels } = require('./candleLevels');
const { startReader } = require('./reader');
const { readOnlyAdapter, StdioAdapter } = require('./transport');

// Called by the TV listener before its ordinary line-to-card handler.
// The host retains ownership of its proxy, broker and application lifecycle.
function attach({ servicesApi, root, getEnabled = () => true, settings,
  createReader = startReader, onStatus = () => {} }) {
  if (servicesApi.candleLevelRenderer) return servicesApi.candleLevelRenderer;
  if (!root) throw Error('Укажите локальный каталог данных ИСКК');
  settings.register('candle-renderer', path.join(__dirname, 'config/candle-renderer.json'),
    path.join(__dirname, 'config/candle-renderer-settings-descriptor.json'),
    { livePaths: ['enabled', 'publishToLT', 'adapterMode', 'readerCommand', 'mappings'] });
  let config = settings.readConfig('candle-renderer')?.config || {};
  const file = path.join(root, 'candle-level-renderer-state.json');
  let initial = {}, reader, transport, transportKey, status = {};
  try { initial = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('Не удалось прочитать сохранённое состояние отрисовщика'); }
  const enabled = () => config.enabled === true && getEnabled();
  const adapter = () => {
    if (config.adapterMode === 'iscc') return readOnlyAdapter(servicesApi.mt5VPS?.getAdapter?.());
    if (config.adapterMode !== 'stdio') throw Error('Выберите способ чтения MT5 в настройках отрисовщика');
    const key = JSON.stringify(config.readerCommand);
    if (key !== transportKey) {
      transport?.close(); transport = new StdioAdapter(config.readerCommand); transportKey = key;
    }
    return transport;
  };
  const sync = new CandleLevelSync({ initial, getConfig: () => ({ ...config, enabled: enabled() }),
    getAdapter: adapter, onNeedBars: () => reader?.refresh(),
    onStatus: value => { status = value; onStatus(value); },
    persist: async value => {
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.writeFile(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
      await fs.promises.rename(file + '.tmp', file);
    },
    publish: async (_levels, latest) => {
      if (!config.publishToLT) return;
      const lt = servicesApi.levelTrack;
      if (typeof lt?.update !== 'function') throw Error('ЛТ требует совместимого последовательного обновления групп');
      await lt.update(value => updateManagedLevels(value, latest()));
    }
  });
  reader = createReader({ enabled, acceptSnapshot: value => sync.acceptSnapshot(value),
    sources: () => Object.keys(require('./candle-mappings').sourceMap(config)), anchors: () => sync.requiredBars(),
    onError: error => { sync.lastError = 'Чтение разметки TradingView: ' + error.message; onStatus(sync.status()); } });
  settings.onApply('candle-renderer', ({ config: next }) => {
    config = next || {}; sync.reconfigure(); sync.publishNeeded = true; reader.refresh();
  });
  sync.start();
  const api = {
    acceptSource(id, source, options) { return enabled() ? sync.acceptSource(id, source, options) : false; },
    acceptBars(value) { if (enabled()) sync.acceptBars(value); },
    status: () => ({ ...status, ...sync.status() }),
    stop() { reader.stop(); sync.stop(); transport?.close(); }
  };
  servicesApi.candleLevelRenderer = api;
  return api;
}
module.exports = { attach };
