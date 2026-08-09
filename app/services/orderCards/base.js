class OrderCardsSource {
  /** @returns {Promise<void>} */
  async start() { throw new Error('Not implemented'); }
  /** @returns {Promise<void>} */
  async stop() { throw new Error('Not implemented'); }
  /** @param {{ rows?: number }} request
      @returns {Promise<any[]>} */
  async list(_request = {}) { throw new Error('Not implemented'); }
}

module.exports = { OrderCardsSource };
