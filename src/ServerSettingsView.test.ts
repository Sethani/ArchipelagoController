import { describe, expect, it } from 'vitest';
import { findGameHostSections } from './ServerSettingsView';

describe('game-specific host settings matching', () => {
  const document = {
    server_options: { port: 38281 },
    stardew_valley_options: { allow_allsanity: true },
    lttp_options: { rom_file: 'Zelda.sfc' },
    universal_tracker: { include_region_name: false },
  };

  it('matches an APWorld manifest ID before display-name aliases', () => {
    expect(findGameHostSections(document, 'Stardew Valley', ['stardew_valley'])).toEqual(['stardew_valley_options']);
    expect(findGameHostSections(document, 'Universal Tracker', ['universal_tracker'])).toEqual(['universal_tracker']);
  });

  it('uses explicit aliases without including global server sections', () => {
    expect(findGameHostSections(document, 'A Link to the Past')).toEqual(['lttp_options']);
    expect(findGameHostSections(document, 'Stardew-ish')).toEqual([]);
  });
});
