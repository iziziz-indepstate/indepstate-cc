const fs = require('fs');
const path = require('path');
const electron = require('electron');

const app = electron?.app;

// Resolve the directory containing the application. In a packaged build prefer
// the folder with the executable so that a sibling `config` directory can be
// used for overrides. When running from source fall back to the current working
// directory.
const APP_ROOT = app?.isPackaged
  ? path.dirname(app.getPath ? app.getPath('exe') : process.execPath)
  : process.cwd();

const APP_NAME = app?.getName ? app.getName() : 'ISCC';
let USER_ROOT;
if (process.platform === 'win32') {
  // On Windows prefer the `%LOCALAPPDATA%` location to keep overrides out of
  // the roaming profile. Fall back to `home\\AppData\\Local` if the env var is
  // missing (e.g. during tests).
  const base = process.env.LOCALAPPDATA ||
    (app?.getPath ? path.join(app.getPath('home'), 'AppData', 'Local')
                   : path.join(require('os').homedir(), 'AppData', 'Local'));
  USER_ROOT = path.join(base, APP_NAME);
} else if (app?.getPath) {
  USER_ROOT = app.getPath('userData');
} else {
  USER_ROOT = APP_ROOT;
}

// Enable logging only when CONFIG_LOG is explicitly set to "1" or "true"
const LOG_ENABLED = /^(1|true)$/i.test(process.env.CONFIG_LOG || '');
const LOG_FILE = path.join(USER_ROOT, 'logs', 'app.txt');
function log(line) {
  if (!LOG_ENABLED) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    console.error('[log] cannot write to log file:', e.message);
  }
}

const CONFIG_ROOTS = [];
CONFIG_ROOTS.push(path.join(APP_ROOT, 'config'));
if (USER_ROOT !== APP_ROOT) {
  CONFIG_ROOTS.push(path.join(USER_ROOT, 'config'));
}
const CONFIG_ROOT = CONFIG_ROOTS[CONFIG_ROOTS.length - 1];

function deepMerge(target, source, desc) {
  if (!source || typeof source !== 'object') return target;
  const allowUnknown = desc && desc.__allowUnknown;
  for (const key of Object.keys(source)) {
    if (String(key).startsWith('__')) continue;
    const srcVal = source[key];
    if (!(key in target)) {
      if (allowUnknown) {
        if (Array.isArray(srcVal)) {
          target[key] = srcVal.slice();
        } else if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
          target[key] = JSON.parse(JSON.stringify(srcVal));
        } else {
          target[key] = srcVal;
        }
      }
      continue; // ignore unknown keys unless allowed
    }
    const tgtVal = target[key];
    const childDesc = desc && desc[key];
    if (Array.isArray(srcVal)) {
      if (Array.isArray(tgtVal)) target[key] = srcVal.slice();
    } else if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      if (childDesc && childDesc.__replace) {
        target[key] = JSON.parse(JSON.stringify(srcVal));
        continue;
      }
      if (tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
        target[key] = deepMerge(tgtVal, srcVal, childDesc);
      }
    } else {
      target[key] = srcVal;
    }
  }
  return target;
}

function load(name) {
  const defaultsPath = path.isAbsolute(name)
    ? name
    : path.join(__dirname, name);
  log(`[config] load defaults ${defaultsPath}`);
  let defaults = {};
  let descriptor = {};
  try {
    defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  } catch (e) {
    console.error(`[config] cannot read default ${name}:`, e.message);
    log(`[config] cannot read default ${defaultsPath}: ${e.message}`);
  }
  try {
    const descriptorPath = defaultsPath.replace(/\.json$/, '-settings-descriptor.json');
    descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')).options || {};
  } catch {}

  const fileName = path.basename(name);
  for (const root of CONFIG_ROOTS) {
    const overridePath = path.join(root, fileName);
    if (fs.existsSync(overridePath)) {
      log(`[config] apply override ${overridePath}`);
      try {
        const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
        // deepMerge mutates its target but also returns it; assign back so callers
        // receive the fully merged object even if implementation changes
        defaults = deepMerge(defaults, override, descriptor);
        log(`[config] merged result ${JSON.stringify(defaults)}`);
      } catch (e) {
        console.error(`[config] cannot read override ${name}:`, e.message);
        log(`[config] cannot read override ${overridePath}: ${e.message}`);
      }
    } else {
      log(`[config] no override found ${overridePath}`);
    }
  }

  log(`[config] final ${JSON.stringify(defaults)}`);
  return defaults;
}

module.exports = Object.assign(load, { APP_ROOT, USER_ROOT, CONFIG_ROOT, CONFIG_ROOTS });
