/**
 * Decimal arithmetic policy (single place, so it is easy to defend).
 *
 *  - All financial arithmetic uses decimal.js, never JS floating point.
 *  - Intermediate values keep full precision: 40 significant digits. (Divisions
 *    such as 3.2 min × ₹850/h ÷ 60 are non-terminating; 40 digits makes the
 *    truncation error ~1e-38, far below one paisa.)
 *  - Rounding happens only at the output boundary, to 2 dp, using
 *    ROUND_HALF_UP (0.125 → 0.13), the conventional commercial rounding.
 *    The mode is passed explicitly at each rounding call and also set on the
 *    cloned constructor, so it does not depend on decimal.js global defaults.
 *  - We use a private clone so we never mutate global Decimal configuration
 *    that other code in the process might rely on.
 */

import Decimal from 'decimal.js';

export const PRECISION_DIGITS = 40;
export const MONEY_DECIMAL_PLACES = 2;
export const ROUNDING_MODE = Decimal.ROUND_HALF_UP;

export const D = Decimal.clone({ precision: PRECISION_DIGITS, rounding: ROUNDING_MODE });
export type Dec = Decimal;

/** Round to money precision (2 dp, half-up). Returns a Decimal for further exact arithmetic. */
export function roundMoney(value: Dec): Dec {
  return value.toDecimalPlaces(MONEY_DECIMAL_PLACES, ROUNDING_MODE);
}

/** Round to 2 dp and serialise as a fixed 2-dp string, e.g. "99.42". */
export function toMoneyString(value: Dec): string {
  return roundMoney(value).toFixed(MONEY_DECIMAL_PLACES, ROUNDING_MODE);
}

