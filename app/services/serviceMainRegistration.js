function mainApplicationServicePhaseFor(manifest = {}) {
  return manifest.mainApplicationServicePhase || 'after-execution';
}

function shouldRegisterMainApplicationService(manifest = {}, context = {}) {
  if (typeof manifest?.registerMainApplicationServices !== 'function') return false;
  const phase = context.phase || 'after-execution';
  return mainApplicationServicePhaseFor(manifest) === phase;
}

function registerMainApplicationServicesForManifests(serviceManifests = [], context = {}, onError = () => {}) {
  for (const { dir, manifest } of serviceManifests) {
    if (!shouldRegisterMainApplicationService(manifest, context)) continue;
    try {
      manifest.registerMainApplicationServices({ ...context, serviceDir: dir });
    } catch (err) {
      onError(err, dir);
    }
  }
}

module.exports = {
  mainApplicationServicePhaseFor,
  shouldRegisterMainApplicationService,
  registerMainApplicationServicesForManifests
};
