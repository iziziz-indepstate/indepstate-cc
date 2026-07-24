const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('../app/services/settings');
const loadConfig = require('../app/config/load');

async function run() {
  const defaultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'defaults-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-'));
  const file = 'sample.json';

  const defaultsPath = path.join(defaultsDir, file);
  fs.writeFileSync(defaultsPath, JSON.stringify({ foo: 1 }, null, 2));
  fs.writeFileSync(path.join(userDir, file), JSON.stringify({ foo: 2, extra: 3 }, null, 2));

  const originalRoots = loadConfig.CONFIG_ROOTS.slice();
  loadConfig.CONFIG_ROOTS.length = 0;
  loadConfig.CONFIG_ROOTS.push(userDir);

  settings.register('sample', defaultsPath);
  let { config } = settings.readConfig('sample');
  assert.deepStrictEqual(config, { foo: 2 });

  // allow arbitrary provider keys when descriptor opts in
  const defaultsDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'defaults2-'));
  const userDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'user2-'));
  const file2 = 'exec.json';
  const defaultsPath2 = path.join(defaultsDir2, file2);
  fs.writeFileSync(defaultsPath2, JSON.stringify({ providers: { base: { a: 1 } } }, null, 2));
  fs.writeFileSync(path.join(defaultsDir2, 'exec-settings-descriptor.json'), JSON.stringify({ properties: {}, options: { providers: { __allowUnknown: true } } }, null, 2));
  fs.writeFileSync(path.join(userDir2, file2), JSON.stringify({ providers: { base: { a: 2 }, extra: { b: 3 } } }, null, 2));

  loadConfig.CONFIG_ROOTS.length = 0;
  loadConfig.CONFIG_ROOTS.push(userDir2);

  settings.register('exec', defaultsPath2, path.join(defaultsDir2, 'exec-settings-descriptor.json'));
  ({ config } = settings.readConfig('exec'));
  assert.deepStrictEqual(config, { providers: { base: { a: 2 }, extra: { b: 3 } } });

  const defaultsDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'defaults3-'));
  const userDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'user3-'));
  const file3 = 'tick-sizes.json';
  const defaultsPath3 = path.join(defaultsDir3, file3);
  fs.writeFileSync(defaultsPath3, JSON.stringify({ bySymbol: { OLD: 0.01 } }, null, 2));
  fs.writeFileSync(path.join(defaultsDir3, 'tick-sizes-settings-descriptor.json'), JSON.stringify({
    properties: {},
    options: { bySymbol: { __allowUnknown: true, __replace: true } }
  }, null, 2));
  fs.writeFileSync(path.join(userDir3, file3), JSON.stringify({ bySymbol: { NEW: 0.001 } }, null, 2));

  loadConfig.CONFIG_ROOTS.length = 0;
  loadConfig.CONFIG_ROOTS.push(userDir3);

  settings.register('tick-test', defaultsPath3, path.join(defaultsDir3, 'tick-sizes-settings-descriptor.json'));
  ({ config } = settings.readConfig('tick-test'));
  assert.deepStrictEqual(config, { bySymbol: { NEW: 0.001 } });

  const defaultsDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'defaults4-'));
  const userDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'user4-'));
  const file4 = 'execution.json';
  const defaultsPath4 = path.join(defaultsDir4, file4);
  fs.writeFileSync(defaultsPath4, JSON.stringify({
    providers: {
      ibkr: {
        contractResolution: {
          profiles: {
            STK: {
              secType: 'STK',
              exchange: 'SMART',
              currency: 'USD',
              preferredPrimaryExchanges: ['NASDAQ']
            }
          },
          profileBySymbol: {},
          defaultProfile: 'STK'
        }
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(defaultsDir4, 'execution-settings-descriptor.json'), JSON.stringify({
    properties: {},
    options: {
      providers: {
        ibkr: {
          contractResolution: {
            profiles: { __allowUnknown: true },
            profileBySymbol: { __allowUnknown: true }
          }
        }
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(userDir4, file4), JSON.stringify({
    providers: {
      ibkr: {
        contractResolution: {
          profiles: { __allowUnknown: {} },
          profileBySymbol: { __allowUnknown: {}, ALNY: 'STK' }
        }
      }
    }
  }, null, 2));

  loadConfig.CONFIG_ROOTS.length = 0;
  loadConfig.CONFIG_ROOTS.push(userDir4);

  settings.register('execution-test', defaultsPath4, path.join(defaultsDir4, 'execution-settings-descriptor.json'));
  ({ config } = settings.readConfig('execution-test'));
  assert.strictEqual(config.providers.ibkr.contractResolution.profiles.__allowUnknown, undefined);
  assert.strictEqual(config.providers.ibkr.contractResolution.profileBySymbol.__allowUnknown, undefined);
  assert.strictEqual(config.providers.ibkr.contractResolution.profileBySymbol.ALNY, 'STK');

  loadConfig.CONFIG_ROOTS.length = 0;
  originalRoots.forEach(r => loadConfig.CONFIG_ROOTS.push(r));

  console.log('settings override tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
