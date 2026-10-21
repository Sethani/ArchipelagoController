import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseUniversalTrackerOutput } = require('./universal-tracker.cjs');

describe('Universal Tracker output', () => {
  it('separates normal and glitched locations from combined list output', () => {
    const result = parseUniversalTrackerOutput(`startup noise\nGame: Metroid Fusion | Slot Name : Sethiduck_MF | In logic locations : 2\nSector 1 - Tank\nMain Deck - Data\nSector 4 - Glitched Tank\n`);
    expect(result).toEqual({ inLogic: 2, glitched: 1, available: 3, locations: ['Sector 1 - Tank', 'Main Deck - Data', 'Sector 4 - Glitched Tank'] });
  });

  it('returns a useful tracker failure', () => {
    expect(() => parseUniversalTrackerOutput('Internal generation failure\nValueError: bad option')).toThrow(/ValueError/);
  });
});
