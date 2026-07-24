# Order Calculator Service

Centralizes order mathematics and shared risk defaults. The service is used by regular order cards, level-order cards, and the pending orders hub to keep calculations consistent.

## Configuration

```json
{
  "profitRate": 3,
  "riskUsd": {
    "byInstrumentType": {
      "EQ": 50,
      "FX": 50,
      "CX": 0.2
    },
    "bySymbol": {
      "ADAUSDT.cfd": 1
    }
  }
}
```

`riskUsd.bySymbol` uses exact symbol matching after trimming and uppercasing, so suffixes such as `.cfd` remain significant. Card risk is resolved in this order:

1. Risk explicitly supplied by the card row.
2. A shared `bySymbol` override.
3. The shared `byInstrumentType` default.

`DEFAULT_EQUITY_STOP_USD` overrides the EQ and FX instrument defaults, while `DEFAULT_CX_STOP_USD` overrides the CX instrument default. Symbol overrides still take precedence.

### Legacy migration

At startup, installations that still define `defaultEquityStopUsd` or `defaultCxStopUsd` in an `order-cards.json` override are migrated automatically. A legacy equity value fills missing EQ and FX overrides, and the legacy crypto value fills a missing CX override. Existing values in `order-calculator.json`, including symbol overrides, are never replaced. Once written, the new override prevents the migration from running again.

## Usage

```javascript
const { OrderCalculator } = require('../app/services/orderCalculator');
const tradeRules = require('../app/services/tradeRules');
const calc = new OrderCalculator({ tradeRules });
const stopPts = calc.stopPts({ tickSize, symbol, entryPrice, stopPrice, instrumentType });
const takePts = calc.takePts(stopPts);
const qty = calc.qty({ riskUsd, stopPts, tickSize, lot, instrumentType });
const defaultRisk = calc.defaultRiskUsd({ symbol, instrumentType });
```

Passing `tradeRules` allows enforcement of minimum stop sizes through `MinStopPointsRule`.
