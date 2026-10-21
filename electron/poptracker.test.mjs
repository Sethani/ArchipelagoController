import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { compareVersions, parseManifest, popTrackerArgs, stripJsonComments } = require('./poptracker.cjs');

describe('PopTracker integration', () => {
  it('reads community manifests containing BOMs, comments, and trailing commas', () => {
    const source = '\uFEFF{\n// pack metadata\n"name":"Example",\n"game_name":"Sample Game",\n"package_uid":"sample",\n"package_version":"1.2",\n"variants":{"map":{"display_name":"Map", "flags":["ap"],},},\n}';
    expect(JSON.parse(stripJsonComments(source))).toMatchObject({ package_uid: 'sample' });
    expect(parseManifest(source, 'sample.zip')).toMatchObject({ uid: 'sample', gameName: 'Sample Game', variants: [{ id: 'map', name: 'Map', supportsAp: true }] });
  });

  it('orders numeric package versions', () => {
    expect(compareVersions('0.3.1', '0.2.5')).toBeGreaterThan(0);
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0);
  });

  it('builds pack, variant, and AP connection arguments', () => {
    const args = popTrackerArgs({ uid: 'sample', version: '1.2', variants: [{ id: 'map', supportsAp: true }] }, 'map', { host: 'archipelago.gg:12345', slot: 'Player One', password: 'secret' });
    expect(args).toEqual(['--load-pack', 'sample', '--pack-version', '1.2', '--pack-variant', 'map', '--ap-host', 'archipelago.gg:12345', '--ap-slot', 'Player One', '--ap-password', 'secret']);
  });
});
