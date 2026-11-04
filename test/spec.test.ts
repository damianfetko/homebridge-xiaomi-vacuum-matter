import { describe, expect, it } from 'vitest';
import { CleaningType, decodeCleaningType, encodeCleaningType } from '../src/device/spec.js';

describe('4.23 cleaning mode encoding', () => {
  it('decodes the value read from the real X20+ (133120 = sweep + mop)', () => {
    expect(decodeCleaningType(133120)).toBe(CleaningType.SweepingAndMopping);
    expect(decodeCleaningType(133122)).toBe(CleaningType.Sweeping);
    expect(decodeCleaningType(133121)).toBe(CleaningType.Mopping);
    expect(decodeCleaningType(133123)).toBe(CleaningType.MoppingAfterSweeping);
  });

  it('keeps the upper bytes when encoding', () => {
    for (const t of [CleaningType.Sweeping, CleaningType.Mopping, CleaningType.SweepingAndMopping, CleaningType.MoppingAfterSweeping]) {
      const v = encodeCleaningType(133120, t);
      expect(v & ~3).toBe(133120);
      expect(decodeCleaningType(v)).toBe(t);
    }
  });
});
