module.exports = {
  ...require('./command'),
  ...require('./domain/strategy'),
  ...require('./application'),
  ...require('./domain/positionBehavior'),
  ...require('./domain/openingPolicy')
};
