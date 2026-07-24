const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping brokerageSettingsRenderer test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const calls = [];
  const descriptor = require('../app/services/brokerage/config/execution-settings-descriptor.json');
  const ipcRenderer = {
    on: () => {},
    invoke: async (ch, ...args) => {
      calls.push({ ch, args });
      if (ch === 'orders:list') return [];
      if (ch === 'settings:list') return [{ key: 'brokerage', name: 'Brokerage' }];
      if (ch === 'settings:get') {
        if (args[0] === 'brokerage') {
          return {
            config: {
              default: 'simulated',
              byInstrumentType: {},
              bySymbol: {},
              providers: {
                ibkr: {
                  adapter: 'ibkr',
                  enabled: false,
                  mode: 'paper',
                  debug: false,
                  host: '127.0.0.1',
                  port: 4002,
                  clientId: 12,
                  accountId: '',
                  defaultTif: 'DAY',
                  instruments: {},
                  quoteTimeoutMs: 5000,
                  marketDataType: 3,
                  defaultTickSize: '',
                  contractResolveTimeoutMs: 5000,
                  contractResolution: {
                    enabled: true,
                    profiles: {
                      STK: {
                        secType: 'STK',
                        exchange: 'SMART',
                        currency: 'USD',
                        preferredPrimaryExchanges: ['NASDAQ']
                      },
                      __allowUnknown: {}
                    },
                    profileBySymbol: { __allowUnknown: {} },
                    defaultProfile: 'STK'
                  }
                }
              }
            },
            descriptor
          };
        }
        return { autoscroll: true };
      }
      if (ch === 'settings:set') return true;
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      return {};
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer };
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  require('../app/renderer.js');
  document.getElementById('settings-btn').click();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const defaultProvider = document.querySelector('input[data-field="default"]');
  assert(defaultProvider);
  defaultProvider.value = 'ibkr';
  defaultProvider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  document.getElementById('settings-close').click();
  await new Promise(resolve => setImmediate(resolve));

  const setCall = calls.find(c => c.ch === 'settings:set' && c.args[0] === 'brokerage');
  assert(setCall);
  const savedCr = setCall.args[1].providers.ibkr.contractResolution;
  assert.strictEqual(savedCr.profiles.__allowUnknown, undefined);
  assert.strictEqual(savedCr.profileBySymbol, undefined);
  assert(!JSON.stringify(setCall.args[1]).includes('__allowUnknown'));
  assert(!JSON.stringify(setCall.args[1]).includes('ALNY'));

  Module._load = originalLoad;
  console.log('brokerageSettingsRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
