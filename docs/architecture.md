# Architecture Decision Records

## ADR-001: Monorepo structure

**Decision:** `server/` + `client/` + `shared/` + `packages/costing-engine/`

**Reason:** Clean separation. The costing engine is independently testable with Vitest without starting Express or Mongoose.

## ADR-002: JWT stored in httpOnly cookies

**Decision:** JWTs are issued as `httpOnly; SameSite=Lax` cookies, not stored in `localStorage`.

**Reason:** Prevents XSS from reading the token. The browser sends the cookie automatically on every same-origin request.

## ADR-003: Rate versioning strategy

**Decision:** Rate records are never updated. A new record is inserted for every rate change. Lookups use `effectiveFrom <= costingDate` with descending sort, taking the first result.

**Reason:** Preserves historical traceability. An old quotation always recalculates identically with its original rates.

## ADR-004: Deterministic costing engine

**Decision:** All costing formulas live in `packages/costing-engine/`. No Express, Mongoose, or React imports. No async. No env vars. Pure TypeScript.

**Reason:** The engine is independently unit-testable. Identical inputs always produce identical outputs.

## ADR-005: Decimal128 for monetary values

**Decision:** All monetary fields in Mongoose schemas use `Decimal128`. All arithmetic uses `decimal.js`.

**Reason:** IEEE 754 floating-point arithmetic is not suitable for financial calculations. `0.1 + 0.2 !== 0.3`.

## ADR-006: Server-side role enforcement

**Decision:** The `authorizeRoles` middleware runs on the Express server. The frontend cannot approve a quote by crafting a request — the server checks the JWT role.

**Reason:** Client-side role checks are UI convenience only, never security.

