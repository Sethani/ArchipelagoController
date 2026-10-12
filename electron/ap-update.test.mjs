import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createApUpdateService, normalizeRelease, updateState } = require('./ap-update.cjs');

const releasePayload = {
  tag_name: '0.6.7',
  html_url: 'https://github.com/ArchipelagoMW/Archipelago/releases/tag/0.6.7',
  published_at: '2026-04-01T17:35:21Z',
  prerelease: false,
  draft: false,
  assets: [{ name: 'Setup.Archipelago.0.6.7.exe', browser_download_url: 'https://github.com/ArchipelagoMW/Archipelago/releases/download/0.6.7/Setup.Archipelago.0.6.7.exe' }],
};

describe('Archipelago update checks', () => {
  it('extracts the stable version and official Windows installer', () => {
    expect(normalizeRelease(releasePayload)).toMatchObject({
      version: '0.6.7',
      installerName: 'Setup.Archipelago.0.6.7.exe',
      installerUrl: releasePayload.assets[0].browser_download_url,
    });
  });

  it('distinguishes outdated, current, and ahead installations', () => {
    const release = normalizeRelease(releasePayload);
    expect(updateState('0.6.6', release).state).toBe('outdated');
    expect(updateState('0.6.7', release).state).toBe('current');
    expect(updateState('0.7.0', release).state).toBe('ahead');
  });

  it('reads the local manifest, checks GitHub once, and reuses the daily cache', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-update-test-'));
    const installRoot = path.join(root, 'Archipelago');
    const userData = path.join(root, 'user-data');
    await fs.mkdir(installRoot, { recursive: true });
    await fs.writeFile(path.join(installRoot, 'manifest.json'), JSON.stringify({ version: [0, 6, 6] }));
    let calls = 0;
    const service = createApUpdateService({
      app: { getPath: () => userData },
      net: { fetch: async () => { calls += 1; return { ok: true, json: async () => releasePayload }; } },
    });
    try {
      expect(await service.check({ installRoot })).toMatchObject({ state: 'outdated', installedVersion: '0.6.6', latestVersion: '0.6.7' });
      expect((await service.check({ installRoot })).state).toBe('outdated');
      expect(calls).toBe(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
