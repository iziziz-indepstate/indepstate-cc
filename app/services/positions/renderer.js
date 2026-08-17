const { debugPositionEvents, positionDebugSummary } = require('../../debugPositionEvents');

function createPositionsRenderer({
  ipcRenderer,
  render,
  onPositionRemoved,
  onPositionSnapshot
} = {}) {
  const positionsById = new Map();

  function setPositionSnapshot(position) {
    if (!position || !position.id) return false;
    positionsById.set(String(position.id), position);
    if (typeof onPositionSnapshot === 'function') onPositionSnapshot(position);
    return true;
  }

  function removePositionSnapshot(positionOrId) {
    const id = typeof positionOrId === 'object' ? positionOrId?.id : positionOrId;
    if (!id) return false;
    return positionsById.delete(String(id));
  }

  function mount() {
    ipcRenderer.invoke('positions:list').then(positions => {
      if (Array.isArray(positions)) {
        for (const position of positions) setPositionSnapshot(position);
      }
      render();
    }).catch(() => {
    });

    ipcRenderer.on('positions:changed', (_evt, payload = {}) => {
      if (payload.event?.type === 'position.removed' || payload.event?.type === 'position.archived') {
        const removedId = payload.position?.id || payload.event?.positionId;
        const storedPosition = removedId ? positionsById.get(String(removedId)) : undefined;
        const removedSnapshot = removePositionSnapshot(payload.position || payload.event?.positionId);
        const removedPosition = payload.position?.card?.type || payload.position?.source?.cardType
          ? payload.position
          : storedPosition || payload.position || payload.event;
        const removedFallback = typeof onPositionRemoved === 'function'
          ? onPositionRemoved(removedPosition)
          : false;
        debugPositionEvents('renderer.positions:changed:receive', {
          eventType: payload.event?.type || '',
          ...positionDebugSummary(payload.position),
          setPositionSnapshot: false,
          removedSnapshot,
          positionsByIdSize: positionsById.size
        });
        if (removedSnapshot || removedFallback) render();
        return;
      }
      const didSet = setPositionSnapshot(payload.position);
      debugPositionEvents('renderer.positions:changed:receive', {
        eventType: payload.event?.type || '',
        ...positionDebugSummary(payload.position),
        setPositionSnapshot: didSet,
        positionsByIdSize: positionsById.size
      });
      if (!didSet) return;
      render();
    });
  }

  return {
    positionsById,
    setPositionSnapshot,
    removePositionSnapshot,
    mount
  };
}

module.exports = {
  createPositionsRenderer
};
