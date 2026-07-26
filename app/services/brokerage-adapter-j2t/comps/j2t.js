// services/brokerage-adapter-j2t/comps/j2t.js
const { ExecutionAdapter } = require('../../brokerage/comps/base'); // путь как у вас

const fetch = require('node-fetch'); // или axios, как удобнее

class J2TExecutionAdapter extends ExecutionAdapter {
  /**
   * @param {Object} cfg
   * @param {string} cfg.baseURL - например https://api.j2t.com
   * @param {string} cfg.accountId
   * @param {string} cfg.accessToken - Bearer JWT
   * @param {number} [cfg.timeoutMs=8000]
   * @param {('gtc'|'gtd')} [cfg.defaultDuration] - опционально
   */
  constructor(cfg) {
    super();
    this.baseURL = cfg.baseURL || 'https://api.j2t.com';
    this.accountId = cfg.accountId;
    this.token = cfg.accessToken;
    this.timeoutMs = cfg.timeoutMs || 8000;
    this.defaultDuration = cfg.defaultDuration;
    if (!this.accountId || !this.token) {
      throw new Error('J2T: accountId and accessToken are required');
    }
  }

  /**
   * order (normalized) ожидается в формате:
   * {
   *   instrumentType: 'EQ',            // проверяем что это акции
   *   symbol: 'AAPL',                  // тикер как у брокера
   *   side: 'buy'|'sell',
   *   type: 'market'|'limit'|'stop'|'stoplimit',
   *   qty: number,                     // целое >=1
   *   limitPrice?: number,             // для limit/stoplimit
   *   stopPrice?: number,              // для stop/stoplimit
   *   meta?: { requestId?: string, riskUsd?: number, ... }
   * }
   */
  async placeOrder(order) {
    try {
      // 0) базовые проверки под акции
      if (!order || order.instrumentType !== 'EQ') {
        return {
          status: 'rejected',
          provider: 'j2t',
          reason: 'J2T adapter accepts only equities (EQ).',
        };
      }

      const instrument = order.symbol; // "LINKUSDT.cfd"
      const side = order.side;
      const type = order.type;
      const qty = Number(order.qty); // 2

      if (!instrument || !side || !type || !Number.isFinite(qty) || qty < 1) {
        return {
          status: 'rejected',
          provider: 'j2t',
          reason: 'Missing/invalid fields: instrument, side, type, qty.',
        };
      }

      // соответствие полей API J2T
      // limitPrice обязателен для limit/stoplimit; stopPrice — для stop/stoplimit
      const body = new URLSearchParams();
      body.set('instrument', instrument);
      body.set('side', side);
      body.set('type', type);
      body.set('qty', String(Math.trunc(qty)));

      if (type === 'limit' || type === 'stoplimit') {
        if (!Number.isFinite(order.limitPrice) || order.limitPrice <= 0) {
          return { status: 'rejected', provider: 'j2t', reason: 'limitPrice required for limit/stoplimit' };
        }
        body.set('limitPrice', String(order.limitPrice));
      }
      if (type === 'stop' || type === 'stoplimit') {
        if (!Number.isFinite(order.stopPrice) || order.stopPrice <= 0) {
          return { status: 'rejected', provider: 'j2t', reason: 'stopPrice required for stop/stoplimit' };
        }
        body.set('stopPrice', String(order.stopPrice));
      }

      // Duration (опционально): gtc|gtd, + durationDateTime для gtd
      if (this.defaultDuration) {
        body.set('durationType', this.defaultDuration); // gtc или gtd
        // если решите присылать expiresAt (unix sec) в order.meta — можно добавить:
        if (this.defaultDuration === 'gtd' && order?.meta?.durationDateTime) {
          body.set('durationDateTime', String(order.meta.durationDateTime));
        }
      }

      // requestId в query — полезно для идемпотентности/склейки логов
      const requestId = order?.meta?.requestId || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const url = new URL(`${this.baseURL}/accounts/${encodeURIComponent(this.accountId)}/orders`);
      url.searchParams.set('requestId', requestId);

      console.log("j2t request -> " + body);

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body,
        // node-fetch v2 не поддерживает timeout опцию напрямую — можно руками AbortController, но опустим для краткости
      });

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { /* оставим raw текст */ }

      // У J2T успешный ответ: { s: 'ok', d: { orderId: '...' } }
      if (res.ok && data && data.s === 'ok' && data.d?.orderId) {
        return {
          status: 'ok',
          provider: 'j2t',
          providerOrderId: String(data.d.orderId),
          raw: data,
        };
      }

      // Ошибка в формате { s:'error', errmsg:'...' } или не-200
      const reason = data?.errmsg || res.statusText || 'Unknown error';
      return {
        status: 'rejected',
        provider: 'j2t',
        reason,
        raw: data || text,
      };

    } catch (err) {
      return {
        status: 'rejected',
        provider: 'j2t',
        reason: err?.message || String(err),
      };
    }
  }

  async getQuote(_symbol) {
    return null;
  }

  // на вырост:
  // async cancelOrder(id) { ... /accounts/{accountId}/orders/{orderId} DELETE ... }
  // async getOrderStatus(id) { ... /accounts/{accountId}/orders ... }
  async closePosition() {
    return { status: 'unsupported', provider: 'j2t', reason: 'J2T closePosition is not implemented' };
  }
}

module.exports = { J2TExecutionAdapter };
