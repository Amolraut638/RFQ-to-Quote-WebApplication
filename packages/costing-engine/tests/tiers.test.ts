import { describe, it, expect } from 'vitest';
import { CostingError, VOLUME_TIERS, BASE_TIER_PERCENTAGE, computeTierVolume } from '../src';

describe('Tier definitions', () => {
  it('are exactly 50%, 100% and 150% in that order', () => {
    expect(VOLUME_TIERS.map((t) => t.percentage)).toEqual([50, 100, 150]);
    expect(BASE_TIER_PERCENTAGE).toBe(100);
  });
});

describe('Integer-volume policy: volume × % / 100, rounded half-up to whole pieces', () => {
  it.each([
    [180000, 50, 90000],
    [180000, 100, 180000],
    [180000, 150, 270000],
    [101, 50, 51], // 50.5 → 51 (half-up)
    [101, 150, 152], // 151.5 → 152
    [3, 50, 2], // 1.5 → 2
    [1, 50, 1], // 0.5 → 1 (never rounds a real part down to zero)
    [7, 150, 11], // 10.5 → 11
    [7, 100, 7],
    [9, 50, 5], // 4.5 → 5
    [10, 50, 5],
  ])('annual %d at %d%% → %d pieces', (annual, pct, expected) => {
    expect(computeTierVolume(annual, pct)).toBe(expected);
  });

  it('always returns an integer', () => {
    for (const annual of [1, 2, 3, 5, 11, 99, 12345]) {
      for (const pct of [50, 100, 150]) {
        expect(Number.isInteger(computeTierVolume(annual, pct))).toBe(true);
      }
    }
  });

  it('rejects a tier whose calculated volume is zero (1 × 10% = 0.1 → 0)', () => {
    expect(() => computeTierVolume(1, 10)).toThrow(CostingError);
    try {
      computeTierVolume(1, 10);
    } catch (e) {
      expect((e as CostingError).code).toBe('INVALID_VOLUME');
    }
  });

  it.each([0, -10, 1.5, NaN])('rejects invalid annual volume %j', (bad) => {
    expect(() => computeTierVolume(bad, 100)).toThrow(CostingError);
  });

  it.each([0, -50, NaN])('rejects invalid tier percentage %j', (bad) => {
    expect(() => computeTierVolume(1000, bad)).toThrow(CostingError);
  });
});

