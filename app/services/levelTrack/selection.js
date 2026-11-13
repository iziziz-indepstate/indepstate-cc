// Shared by the live card preview and execution resolver. Config order breaks ties.
function selectTrackedLevel(snapshot, ticker) {
  if (!snapshot) return { status: 'waiting' };
  if (snapshot.error) return { status: 'unavailable', reason: snapshot.error };
  const groups = (snapshot.config?.groups || []).filter(group =>
    group.enabled !== false && String(group.ticker || '').trim().toUpperCase() === String(ticker || '').trim().toUpperCase());
  if (!groups.length) return { status: 'empty' };
  const states = groups.map(group => ({
    ...(snapshot.states || []).find(state => state.key === group.key), key: group.key
  }));
  const nearest = candidates => candidates.reduce((best, state) => {
    const distance = Number.isFinite(state.distance) ? state.distance : Infinity;
    return !best || distance < (Number.isFinite(best.distance) ? best.distance : Infinity) ? state : best;
  }, null);
  const active = nearest(states.filter(state => state.status === 'active' && Number.isFinite(state.activeLevel) && state.activeLevel > 0));
  if (active) return { ...active, level: active.activeLevel, status: 'active' };
  const inactive = nearest(states.filter(state => state.status === 'inactive' && Number.isFinite(state.nearestLevel) && state.nearestLevel > 0));
  if (inactive) return { ...inactive, level: inactive.nearestLevel, status: 'inactive' };
  const unavailable = states.find(state => state.status && state.status !== 'idle');
  return unavailable ? { ...unavailable, status: 'unavailable' } : { status: 'waiting' };
}

module.exports = { selectTrackedLevel };
