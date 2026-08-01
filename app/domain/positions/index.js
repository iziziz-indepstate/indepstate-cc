const { PositionAggregate, normalizePnlSnapshot } = require('./aggregate');
const types = require('./types');
const policies = require('./policies');
const cardMetadata = require('./cardMetadata');
const behaviorRegistry = require('./behaviorRegistry');
const openingPolicyRegistry = require('./openingPolicyRegistry');

module.exports = {
  PositionAggregate,
  normalizePnlSnapshot,
  ...types,
  ...policies,
  ...cardMetadata,
  ...behaviorRegistry,
  ...openingPolicyRegistry
};
