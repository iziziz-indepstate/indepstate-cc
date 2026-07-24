const { stripExchangePrefix } = require('../instruments');

function stripSymbol(value) {
  return stripExchangePrefix(value);
}

module.exports = { stripSymbol };
