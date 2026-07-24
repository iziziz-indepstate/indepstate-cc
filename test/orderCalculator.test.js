const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OrderCalculator } = require('../app/services/orderCalculator');
const { migrateLegacyRiskConfig } = require('../app/services/orderCalculator/migrateLegacyRiskConfig');

function testOrderCalculator() {
  console.log('Running OrderCalculator tests...');

  // Stub tradeRules
  const tradeRules = {
    rules: [
      {
        constructor: { name: 'MinStopPointsRule' },
        _min: (card) => card.instrumentType === 'FX' ? 20 : 6
      }
    ]
  };

  // Test default config loading
  const calc = new OrderCalculator({ tradeRules });
  assert.strictEqual(calc.config.profitRate, 3);

  // Test takePts with default rate
  assert.strictEqual(calc.takePts(10), 30);

  // Test stopPts with tradeRules min stop points
  const pts = calc.stopPts({ tickSize: 1, symbol: 'TEST', entryPrice: 100, stopPrice: 98, instrumentType: 'EQ' });
  assert.strictEqual(pts, 6, `Expected 6 points (min), got ${pts}`);

  const ptsFx = calc.stopPts({ tickSize: 1, symbol: 'TEST', entryPrice: 100, stopPrice: 95, instrumentType: 'FX' });
  assert.strictEqual(ptsFx, 20, `Expected 20 points (min FX), got ${ptsFx}`);

  // Test custom config
  const customCalc = new OrderCalculator({
    tradeRules,
    config: {
      profitRate: 5
    }
  });

  assert.strictEqual(customCalc.takePts(10), 50);

  const riskCalc = new OrderCalculator({
    tradeRules,
    config: {
      profitRate: 3,
      riskUsd: {
        byInstrumentType: { EQ: 50, FX: 40, CX: 0.2 },
        bySymbol: { 'Special.cfd': 7 }
      }
    }
  });
  assert.strictEqual(riskCalc.defaultRiskUsd({ symbol: 'AAPL', instrumentType: 'EQ' }), 50);
  assert.strictEqual(riskCalc.defaultRiskUsd({ symbol: 'EURUSD', instrumentType: 'FX' }), 40);
  assert.strictEqual(riskCalc.defaultRiskUsd({ symbol: 'BTCUSDT.P' }), 0.2);
  assert.strictEqual(riskCalc.defaultRiskUsd({ symbol: ' special.CFD ', instrumentType: 'EQ' }), 7);
  assert.strictEqual(riskCalc.defaultRiskUsd({ symbol: 'SPECIAL', instrumentType: 'EQ' }), 50);
  riskCalc.configure({
    profitRate: 4,
    riskUsd: {
      byInstrumentType: { EQ: 25, FX: 30, CX: 0.1 },
      bySymbol: { AAPL: 9 }
    }
  });
  assert.strictEqual(riskCalc.defaultRiskUsd({ symbol: 'aapl', instrumentType: 'EQ' }), 9);
  assert.strictEqual(riskCalc.defaultRiskUsd({ symbol: 'MSFT', instrumentType: 'EQ' }), 25);
  assert.strictEqual(riskCalc.takePts(10), 40);

  const qtyCxFine = calc.qty({ riskUsd: 15, stopPts: 12, tickSize: 0.0001, lot: 1, instrumentType: 'CX' });
  assert.strictEqual(qtyCxFine, 12500);

  const qtyCxWrongTick = calc.qty({ riskUsd: 15, stopPts: 12, tickSize: 0.01, lot: 1, instrumentType: 'CX' });
  assert.strictEqual(qtyCxWrongTick, 125);

  const qtyCxNoTick = calc.qty({ riskUsd: 15, stopPts: 35, tickSize: undefined, lot: 1, instrumentType: 'CX' });
  assert.strictEqual(qtyCxNoTick, 0);

  const qtyCxApprox = calc.qty({ riskUsd: 15, stopPts: 35, tickSize: 0.0001, lot: 1, instrumentType: 'CX' });
  assert.ok(Math.abs(qtyCxApprox - 4285.714) < 0.01);

  const qtyEqDefaultStep = calc.qty({ riskUsd: 10, stopPts: 609, tickSize: 0.025, lot: 1, instrumentType: 'EQ' });
  assert.strictEqual(qtyEqDefaultStep, 0);

  const qtyEqFractionalStep = calc.qty({ riskUsd: 10, stopPts: 609, tickSize: 0.025, lot: 1, instrumentType: 'EQ', quantityStep: 0.1 });
  assert.strictEqual(qtyEqFractionalStep, 0.6);

  console.log('OrderCalculator tests passed!');
}

function testLegacyRiskMigration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iscc-risk-migration-'));
  const appRoot = path.join(root, 'app');
  const userRoot = path.join(root, 'user');
  const appConfig = path.join(appRoot, 'config');
  const userConfig = path.join(userRoot, 'config');
  fs.mkdirSync(appConfig, { recursive: true });
  fs.mkdirSync(userConfig, { recursive: true });
  fs.writeFileSync(path.join(appConfig, 'order-cards.json'), JSON.stringify({
    defaultEquityStopUsd: 50,
    defaultCxStopUsd: 0.5
  }));
  fs.writeFileSync(path.join(userConfig, 'order-cards.json'), JSON.stringify({
    defaultEquityStopUsd: 15,
    defaultCxStopUsd: 0.2
  }));
  fs.writeFileSync(path.join(userConfig, 'order-calculator.json'), JSON.stringify({
    profitRate: 5,
    riskUsd: {
      byInstrumentType: { EQ: 25 },
      bySymbol: { AAPL: 3 }
    }
  }));

  const messages = [];
  const logger = {
    info(message) { messages.push(message); },
    error(message) { messages.push(message); }
  };
  const first = migrateLegacyRiskConfig({
    configRoots: [appConfig, userConfig],
    userRoot,
    logger
  });
  assert.deepStrictEqual(first.additions, { FX: 15, CX: 0.2 });
  assert.strictEqual(first.migrated, true);
  const migrated = JSON.parse(fs.readFileSync(path.join(userConfig, 'order-calculator.json'), 'utf8'));
  assert.strictEqual(migrated.profitRate, 5);
  assert.deepStrictEqual(migrated.riskUsd.byInstrumentType, { EQ: 25, FX: 15, CX: 0.2 });
  assert.deepStrictEqual(migrated.riskUsd.bySymbol, { AAPL: 3 });
  assert.strictEqual(messages.length, 1);

  const second = migrateLegacyRiskConfig({
    configRoots: [appConfig, userConfig],
    userRoot,
    logger
  });
  assert.strictEqual(second.migrated, false);
  assert.deepStrictEqual(second.additions, {});
  assert.strictEqual(messages.length, 1);

  fs.rmSync(root, { recursive: true, force: true });
}

try {
  testOrderCalculator();
  testLegacyRiskMigration();
} catch (err) {
  console.error('OrderCalculator tests failed:');
  console.error(err);
  process.exit(1);
}
