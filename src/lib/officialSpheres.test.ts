/// <reference types="node" />
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseOfficialSphereHtml } = require('../../electron/official-spheres.cjs') as {
  parseOfficialSphereHtml: (html: string, dashboard: unknown, packages: unknown, refreshedAt?: string) => import('../types').RoomSphereSnapshot;
};

const dashboard = {
  players: [
    { slot: 1, name: 'Finder', game: 'Minecraft' },
    { slot: 2, name: 'Receiver', game: 'The Witness' },
  ],
};
const packages = {
  Minecraft: { location_name_to_id: { 'Village Chest': 42001 } },
  'The Witness': { item_name_to_id: { 'Laser Activation': 158000 } },
};

describe('official Archipelago sphere tracker parser', () => {
  it('normalizes checked sphere table rows and resolves IDs', () => {
    const html = `<table><tbody><tr><td>3</td><td>Finder</td><td>Receiver</td><td>Laser Activation</td><td>Village Chest</td><td>Minecraft</td></tr></tbody></table>`;
    expect(parseOfficialSphereHtml(html, dashboard, packages, '2026-11-04T00:00:00.000Z')).toEqual({
      refreshedAt: '2026-11-04T00:00:00.000Z', available: true,
      checks: [{
        sphere: 3, finderSlot: 1, finderName: 'Finder', finderGame: 'Minecraft',
        receiverSlot: 2, receiverName: 'Receiver', receiverGame: 'The Witness',
        itemId: 158000, item: 'Laser Activation', locationId: 42001, location: 'Village Chest',
      }],
    });
  });

  it('reports old seeds and changed markup precisely', () => {
    expect(parseOfficialSphereHtml('This Multiworld has no Sphere data', dashboard, packages).reason).toBe('old-seed');
    expect(parseOfficialSphereHtml('<html>changed</html>', dashboard, packages).reason).toBe('malformed');
  });
});
