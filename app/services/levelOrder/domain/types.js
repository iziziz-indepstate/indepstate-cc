const LevelOrderPositionEvent = Object.freeze({
  CHILDREN_REQUESTED: 'position.levelChildrenRequested'
});

const LevelOrderIntegrationCommand = Object.freeze({
  PLACE_CHILDREN: 'execution.placeLevelChildren'
});

module.exports = {
  LevelOrderPositionEvent,
  LevelOrderIntegrationCommand
};
