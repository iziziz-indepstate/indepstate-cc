const { ExecutionAdapter } = require('../../brokerage/comps/base');

class SimulatedAdapter extends ExecutionAdapter {
  constructor({ latencyMs = [120, 350] } = {}) {
    super();
    this.latencyMs = latencyMs;
    this.provider = 'simulated';
  }
  async placeOrder(order) {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const rand = (a,b)=>Math.floor(a+Math.random()*(b-a+1));
    await wait(rand(this.latencyMs[0], this.latencyMs[1]));
    // простая серверная проверка на всякий случай
    if (order.instrumentType === 'EQ' && (!(order.meta?.riskUsd > 0) || !(order.sl > 0))) {
      return { status:'rejected', provider:this.provider, reason:'Server validation failed (EQ)' };
    }
    if (order.instrumentType === 'CX' && (!(order.qty > 0) || !(order.price > 0) || !(order.sl > 0))) {
      return { status:'rejected', provider:this.provider, reason:'Server validation failed (CX)' };
    }
    console.log(`[Adapter:${this.provider}] placing`, order);
    return {
      status: 'simulated',
      provider: this.provider,
      providerOrderId: `SIM-${Date.now()}-${Math.floor(Math.random()*1e4)}`,
      raw: { echo: order }
    };
  }

  async getQuote(_symbol) {
    // для симуляции вернём фиксированную цену
    return { bid: 100, ask: 100, price: 100, tickSize: 0.01 };
  }

  async getInstrumentMetadata() {
    return { tickSize: 0.01, quantityStep: 1, minQty: 1, contractSize: 1, sources: { tickSize: 'simulated' } };
  }

  async cancelOrder() {
    return { status: 'ok', provider: this.provider };
  }
}
module.exports = { SimulatedAdapter };
