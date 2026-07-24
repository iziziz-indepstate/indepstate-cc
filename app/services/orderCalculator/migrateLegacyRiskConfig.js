const fs = require('fs');
const path = require('path');
const loadConfig = require('../../config/load');

function readJson(filePath, fsImpl) {
  if (!fsImpl.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  if (value == null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function explicitInstrumentRisk(configRoots, instrumentType, fsImpl) {
  let value;
  for (const root of configRoots) {
    const config = readJson(path.join(root, 'order-calculator.json'), fsImpl);
    const candidate = finiteNumber(config?.riskUsd?.byInstrumentType?.[instrumentType]);
    if (candidate !== undefined) value = candidate;
  }
  return value;
}

function legacyRisk(configRoots, key, fsImpl) {
  let value;
  for (const root of configRoots) {
    const config = readJson(path.join(root, 'order-cards.json'), fsImpl);
    const candidate = finiteNumber(config?.[key]);
    if (candidate !== undefined) value = candidate;
  }
  return value;
}

function migrateLegacyRiskConfig({
  configRoots = loadConfig.CONFIG_ROOTS,
  userRoot = loadConfig.USER_ROOT,
  fsImpl = fs,
  logger = console
} = {}) {
  const roots = Array.isArray(configRoots) ? configRoots : [];
  const legacyEquity = legacyRisk(roots, 'defaultEquityStopUsd', fsImpl);
  const legacyCx = legacyRisk(roots, 'defaultCxStopUsd', fsImpl);
  const additions = {};

  if (legacyEquity !== undefined) {
    if (explicitInstrumentRisk(roots, 'EQ', fsImpl) === undefined) additions.EQ = legacyEquity;
    if (explicitInstrumentRisk(roots, 'FX', fsImpl) === undefined) additions.FX = legacyEquity;
  }
  if (legacyCx !== undefined && explicitInstrumentRisk(roots, 'CX', fsImpl) === undefined) {
    additions.CX = legacyCx;
  }

  if (!Object.keys(additions).length) {
    return { migrated: false, additions: {} };
  }

  const overridePath = path.join(userRoot, 'config', 'order-calculator.json');
  const current = readJson(overridePath, fsImpl) || {};
  const next = {
    ...current,
    riskUsd: {
      ...(current.riskUsd && typeof current.riskUsd === 'object' ? current.riskUsd : {}),
      byInstrumentType: {
        ...(current.riskUsd?.byInstrumentType && typeof current.riskUsd.byInstrumentType === 'object'
          ? current.riskUsd.byInstrumentType
          : {}),
        ...additions
      }
    }
  };

  try {
    fsImpl.mkdirSync(path.dirname(overridePath), { recursive: true });
    const temporaryPath = `${overridePath}.migration-${process.pid}.tmp`;
    fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
    fsImpl.renameSync(temporaryPath, overridePath);
    logger.info?.(`[orderCalculator] Migrated legacy risk defaults to ${overridePath}`);
    return { migrated: true, additions, overridePath };
  } catch (error) {
    logger.error?.(`[orderCalculator] Failed to migrate legacy risk defaults: ${error.message}`);
    return { migrated: false, additions, overridePath, error };
  }
}

module.exports = {
  migrateLegacyRiskConfig,
  readJson
};
