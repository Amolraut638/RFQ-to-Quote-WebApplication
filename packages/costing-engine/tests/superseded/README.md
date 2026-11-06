# Superseded Day-1 tests

`engine.day1-legacy.test.ts` is the original Day-1 TDD suite. It is **kept, not deleted**, but
excluded from the test run (`vitest.config.ts`), because the Day-2 specification changed the
contract it tests, so it cannot pass against the current engine without being rewritten:

| Topic | Day-1 test assumed | Day-2 specification |
|---|---|---|
| Entry point / input shape | `calculateCost(CostingEngineInput)`, cycle time in **seconds**, per-process codes | `calculateCosting(CostingInput)`, cycle time in **minutes**, `routingOperations` |
| Selling price | `cost / (1 - margin)` (margin on selling price) | `cost × (1 + margin)` (markup on cost) |
| Overhead basis | conversion cost only | material + scrap + conversion |
| Scrap | `(1 + scrap%)` folded into material | separate scrap cost = material × scrap% |
| Approval | per-piece cost vs threshold | annual quotation value `> ₹25,00,000` |
| Volumes | caller-supplied tiers | fixed 50% / 100% / 150% of annual volume |
| Zero rate | `MISSING_RATE` | zero allowed; only missing/negative rejected |

Its scenarios (zero setup, multiple tiers, missing rate, zero/negative volume, precision,
approval boundary, GST edge cases, single process) are re-expressed against the Day-2 contract in
`tests/engine.test.ts`, `tests/validation.test.ts`, `tests/tiers.test.ts` and `tests/approval.test.ts`.

