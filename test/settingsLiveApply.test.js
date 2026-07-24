const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('../app/services/settings');
const loadConfig = require('../app/config/load');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iscc-live-settings-'));
  const defaultsDir = path.join(root, 'defaults');
  const overrideDir = path.join(root, 'config');
  fs.mkdirSync(defaultsDir, { recursive: true });
  fs.mkdirSync(overrideDir, { recursive: true });
  const defaultsPath = path.join(defaultsDir, 'live-test.json');
  fs.writeFileSync(defaultsPath, JSON.stringify({ live: 1, restart: 1, nested: { value: 1 } }));

  const originalRoots = loadConfig.CONFIG_ROOTS.slice();
  const originalUserRoot = loadConfig.USER_ROOT;
  loadConfig.CONFIG_ROOTS.length = 0;
  loadConfig.CONFIG_ROOTS.push(overrideDir);
  loadConfig.USER_ROOT = root;

  settings.register('live-test', defaultsPath, null, {
    livePaths: ['live', 'nested'],
    restartPaths: ['restart']
  });
  const applied = [];
  settings.onApply('live-test', ({ config, changedPaths }) => {
    applied.push({ config, changedPaths });
  });

  let result = await settings.saveAndApplyConfig('live-test', { live: 2, restart: 1, nested: { value: 1 } });
  assert.deepStrictEqual(result.appliedPaths, ['live']);
  assert.deepStrictEqual(result.restartRequiredPaths, []);
  assert.strictEqual(applied.length, 1);

  result = await settings.saveAndApplyConfig('live-test', { live: 2, restart: 2, nested: { value: 3 } });
  assert.deepStrictEqual(result.appliedPaths, ['nested.value']);
  assert.deepStrictEqual(result.restartRequiredPaths, ['restart']);
  assert.deepStrictEqual(settings.getRestartStatus(), [{ section: 'live-test', paths: ['restart'] }]);

  result = await settings.saveAndApplyConfig('live-test', { live: 2, restart: 1, nested: { value: 3 } });
  assert.deepStrictEqual(result.restartRequiredPaths, []);
  assert.deepStrictEqual(settings.getRestartStatus(), []);

  const failedPath = path.join(defaultsDir, 'failure-test.json');
  fs.writeFileSync(failedPath, JSON.stringify({ tokenValue: 1 }));
  settings.register('failure-test', failedPath, null, { livePaths: ['*'] });
  settings.onApply('failure-test', () => { throw new Error('token=super-secret'); });
  result = await settings.saveAndApplyConfig('failure-test', { tokenValue: 2 });
  assert.deepStrictEqual(result.appliedPaths, []);
  assert.deepStrictEqual(result.restartRequiredPaths, ['tokenValue']);
  assert.strictEqual(result.errors[0].includes('super-secret'), false);
  assert.strictEqual(result.errors[0].includes('[redacted]'), true);

  assert.deepStrictEqual(settings.changedPaths({ a: [1] }, { a: [2] }), ['a']);

  loadConfig.USER_ROOT = originalUserRoot;
  loadConfig.CONFIG_ROOTS.length = 0;
  originalRoots.forEach(value => loadConfig.CONFIG_ROOTS.push(value));
  console.log('settings live apply tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
