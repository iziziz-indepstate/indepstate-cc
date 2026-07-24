class ExecutionAdapter {
  /** @returns {Promise<{status:'ok'|'rejected'|'simulated', provider:'string', providerOrderId?:string, reason?:string, raw?:any}>} */
  async placeOrder(order /* normalized */) {
    throw new Error('Not implemented');
  }
  // На вырост:
  // async cancelOrder(id) {}
  // async getOrderStatus(id) {}

  /** @returns {Promise<any[]>} список открытых ордеров */
  async listOpenOrders() { return []; }

  /** @returns {Promise<any[]>} история закрытых позиций */
  async listClosedPositions() { return []; }

  // Optional adapter contract:
  // async getHistoricBars({ symbol, timeframe, from, to, limit, timeoutMs }) {}

  /**
   * Получить котировку/информацию по инструменту.
   * @param {string} symbol
   * @returns {Promise<{bid?:number, ask?:number, price?:number, tickSize?:number}|null>}
   */
  async getQuote(_symbol) { return null; }

  /**
   * Optional stable trading metadata for a symbol.
   * @returns {Promise<{tickSize?:number,quantityStep?:number,minQty?:number,maxQty?:number,minNotional?:number,contractSize?:number}|null>}
   */
  async getInstrumentMetadata(_symbol) { return null; }

  // Optional non-blocking creation hook for adapters backed by one safe batch metadata request:
  // async preloadInstrumentMetadata() {}

  async forgetQuote(_symbol) { return; }
}
module.exports = { ExecutionAdapter };
