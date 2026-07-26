let config = { enabled: false };

function normalizeConfig(next = {}) {
  return { enabled: next?.enabled === true };
}

function configure(next = {}) {
  config = normalizeConfig(next);
  return getConfig();
}

function getConfig() {
  return { ...config };
}

function isEnabled() {
  return config.enabled === true;
}

function shouldRetry() {
  return isEnabled();
}

module.exports = {
  configure,
  getConfig,
  isEnabled,
  shouldRetry
};
