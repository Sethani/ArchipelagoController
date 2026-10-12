import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const {
  compareVersions, compatibility, createApWorldService, legacyPackageInfo, manifestInfo, mergeCommunity, normalizeIndex, normalizeSheet,
} = require('./apworlds.cjs');

function packageBuffer(id, manifest) {
  return Buffer.from(zipSync({
    [`${id}/archipelago.json`]: strToU8(JSON.stringify(manifest)),
    [`${id}/__init__.py`]: strToU8('class World: pass\n'),
  }));
}

describe('APWorld catalog normalization', () => {
  it('orders final, prerelease, and post releases by version semantics', () => {
    expect(compareVersions('1.7', '2.0a4')).toBeLessThan(0);
    expect(compareVersions('2.0', '2.0rc2')).toBeGreaterThan(0);
    expect(compareVersions('2.0.post2', '2.0')).toBeGreaterThan(0);
  });

  it('normalizes the live index shape and derives trusted GitHub links', () => {
    const hash = 'a'.repeat(64);
    const entries = normalizeIndex({
      index_version: 1,
      worlds: [{
        world: 'https://github.com/example/world/releases/download/v1.2.0/example.apworld',
        size: 42,
        hash_sha256: hash,
        metadata: { id: 'example', world_version: '1.2.0', tag_version: 'v1.2.0', minimum_ap_version: '0.6.7' },
      }],
      meta: { example: { game: 'Example Game', description: 'Example', authors: ['Author'] } },
    });
    expect(entries[0].game).toBe('Example Game');
    expect(entries[0].sourceUrl).toBe('https://github.com/example/world');
    expect(entries[0].releases[0]).toMatchObject({ id: hash, version: '1.2.0', channel: 'Release' });
  });

  it('reads the spreadsheet header after its explanatory first row', () => {
    const rows = normalizeSheet('Explanation,,,,\nGame,Stability,PR Status,18+ / Unrated,Disclosures,Notes\nExample,Stable,In Review,No,Minimal,"Useful, note"\n');
    expect(rows).toEqual([{ game: 'Example', stability: 'Stable', prStatus: 'In Review', adult: false, disclosure: 'Minimal', notes: 'Useful, note' }]);
  });

  it('accepts Google visualization headers containing column notes', () => {
    const rows = normalizeSheet('"Hover for details! Game","Leave a comment. Stability","PR Status","18+ / Unrated","Disclosures","Notes"\n"Example","Unstable","--","TRUE","Consulted","Testing"\n');
    expect(rows[0]).toMatchObject({ game: 'Example', stability: 'Unstable', adult: true, disclosure: 'Consulted' });
  });

  it('keeps community stability separate from index release state', () => {
    const merged = mergeCommunity([{ id: 'example', game: 'Example', description: '', authors: [], releases: [], flags: ['unready'] }], [{ game: 'Example', stability: 'Stable', adult: false }]);
    expect(merged[0].communityStatus).toBe('Stable');
    expect(merged[0].releases).toEqual([]);
  });
});

describe('APWorld package inspection', () => {
  it('reads a valid manifest without executing package code', () => {
    const info = manifestInfo(packageBuffer('example', { game: 'Example', world_version: '1.0.0', minimum_ap_version: '0.6.7', authors: ['Author'] }));
    expect(info).toMatchObject({ id: 'example', game: 'Example', version: '1.0.0', minimumApVersion: '0.6.7' });
  });

  it('accepts an unmanaged package with a mixed-case Python module root', () => {
    const info = manifestInfo(packageBuffer('Hades2Rogue', { game: 'Hades2Rogue', world_version: '0.9.3', minimum_ap_version: '0.6.4' }));
    expect(info).toMatchObject({ id: 'Hades2Rogue', game: 'Hades2Rogue', version: '0.9.3', minimumApVersion: '0.6.4' });
  });

  it('detects a legacy game registration without executing package code', () => {
    const buffer = Buffer.from(zipSync({
      'mm_recomp/__init__.py': strToU8('class MMRWorld:\n    game = "Majora\'s Mask Recompiled"\n'),
      'mm_recomp/Options.py': strToU8('raise RuntimeError("must not execute")\n'),
    }));
    expect(legacyPackageInfo(buffer)).toEqual({ id: 'mm_recomp', game: "Majora's Mask Recompiled" });
  });

  it('rejects catalog packages whose root does not match the indexed ID', () => {
    expect(() => manifestInfo(packageBuffer('wrong', { game: 'Example' }), 'example')).toThrow(/does not match/);
  });

  it('rejects unsafe ZIP paths', () => {
    const buffer = Buffer.from(zipSync({ '../outside.txt': strToU8('bad'), 'example/archipelago.json': strToU8('{"game":"Example"}') }));
    expect(() => manifestInfo(buffer)).toThrow(/Unsafe path/);
  });

  it('reports AP compatibility bounds independently', () => {
    expect(compatibility('0.6.5', '0.6.8', '0.6.7')).toBe('Compatible');
    expect(compatibility('0.7.0', undefined, '0.6.7')).toBe('Too old');
    expect(compatibility(undefined, '0.6.6', '0.6.7')).toBe('Too new');
    expect(compatibility(undefined, undefined, undefined)).toBe('Unknown');
  });
});

describe('APWorld filesystem transactions', () => {
  it('installs verified packages, replaces by manifest ID, and recycles removals', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'apworld-manager-test-'));
    const userData = path.join(root, 'user-data');
    const installRoot = path.join(root, 'Archipelago');
    const customRoot = path.join(installRoot, 'custom_worlds');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(customRoot, { recursive: true });
    await fs.writeFile(path.join(installRoot, 'manifest.json'), JSON.stringify({ version: [0, 6, 7] }));
    const first = packageBuffer('example', { game: 'Example', world_version: '1.0.0' });
    const second = packageBuffer('example', { game: 'Example', world_version: '1.1.0' });
    const release = (buffer, version, url) => ({ id: createHash('sha256').update(buffer).digest('hex'), version, tagVersion: version, url, releaseUrl: url, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), channel: 'Release', flags: [] });
    const releases = [release(second, '1.1.0', 'https://example.test/second'), release(first, '1.0.0', 'https://example.test/first')];
    await fs.writeFile(path.join(userData, 'apworld-catalog.json'), JSON.stringify({ indexEntries: [{ id: 'example', game: 'Example', description: '', authors: [], releases }], sheetRows: [], sources: [] }));
    const downloads = new Map([[releases[0].url, second], [releases[1].url, first]]);
    const recycled = [];
    const service = createApWorldService({
      app: { getPath: () => userData },
      net: { fetch: async (url) => { const buffer = downloads.get(url); return { ok: Boolean(buffer), status: buffer ? 200 : 404, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }; } },
      shell: { trashItem: async (filePath) => { recycled.push(path.basename(filePath)); await fs.rm(filePath, { force: true }); } },
    });
    try {
      expect((await service.install({ installRoot, worldId: 'example', releaseId: releases[1].id })).ok).toBe(true);
      const [installedMatch, typoMatch] = await service.resolveGames({ installRoot, games: ['example', 'Exampel'] });
      expect(installedMatch.status).toBe('Installed');
      expect(typoMatch).toMatchObject({ status: 'Missing', suggestion: 'Example' });
      await fs.rename(path.join(customRoot, 'example.apworld'), path.join(customRoot, 'LegacyName.apworld'));
      expect((await service.install({ installRoot, worldId: 'example', releaseId: releases[0].id })).ok).toBe(true);
      expect((await service.inventory(installRoot)).installed).toHaveLength(1);
      expect((await service.inventory(installRoot)).installed[0].version).toBe('1.1.0');
      expect(recycled).toHaveLength(1);
      expect((await service.remove({ installRoot, worldId: 'example' })).ok).toBe(true);
      expect((await service.inventory(installRoot)).installed).toHaveLength(0);
      expect(recycled).toHaveLength(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('distinguishes legacy template hints, incompatible worlds, and duplicate providers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'apworld-resolution-test-'));
    const userData = path.join(root, 'user-data');
    const installRoot = path.join(root, 'Archipelago');
    await fs.mkdir(path.join(installRoot, 'custom_worlds'), { recursive: true });
    await fs.mkdir(path.join(installRoot, 'lib', 'worlds'), { recursive: true });
    await fs.mkdir(path.join(installRoot, 'Players', 'Templates'), { recursive: true });
    await fs.writeFile(path.join(installRoot, 'manifest.json'), JSON.stringify({ version: [0, 6, 7] }));
    await fs.writeFile(path.join(installRoot, 'custom_worlds', 'future.apworld'), packageBuffer('future', { game: 'Future Game', minimum_ap_version: '9.0.0' }));
    await fs.writeFile(path.join(installRoot, 'custom_worlds', 'example.apworld'), packageBuffer('example', { game: 'Example' }));
    await fs.writeFile(path.join(installRoot, 'custom_worlds', 'dark_souls_3.apworld'), Buffer.from(zipSync({
      'dark_souls_3/__init__.py': strToU8('game = "Dark Souls III"\n'),
      'dark_souls_3/Options.py': strToU8('class Options: pass\n'),
    })));
    await fs.writeFile(path.join(installRoot, 'custom_worlds', 'mm_recomp.apworld'), Buffer.from(zipSync({
      'mm_recomp/__init__.py': strToU8('class MMRWorld:\n    game = "Majora\'s Mask Recompiled"\n'),
    })));
    await fs.writeFile(path.join(installRoot, 'lib', 'worlds', 'core_example.apworld'), packageBuffer('core_example', { game: 'Example' }));
    await fs.writeFile(path.join(installRoot, 'lib', 'worlds', 'dark_souls_3.apworld'), packageBuffer('dark_souls_3', { game: 'Dark Souls III' }));
    await fs.writeFile(path.join(installRoot, 'Players', 'Templates', 'Legacy Game.yaml'), 'name: Player\ngame: Legacy Game\n');
    const service = createApWorldService({ app: { getPath: () => userData }, net: { fetch: async () => ({ ok: false, status: 404 }) }, shell: { trashItem: async () => {} } });
    try {
      const [legacy, incompatible, ambiguous, override, customLegacy] = await service.resolveGames({ installRoot, games: ['Legacy Game', 'Future Game', 'Example', 'Dark Souls III', "Majora's Mask Recompiled"] });
      expect(legacy.status).toBe('Possible legacy match');
      expect(incompatible.status).toBe('Installed but incompatible');
      expect(ambiguous.status).toBe('Ambiguous');
      expect(override.status).toBe('Installed with override');
      expect(override.candidates.map((item) => item.source).sort()).toEqual(['built-in', 'custom-legacy']);
      expect(customLegacy.status).toBe('Possible legacy match');
      expect(customLegacy.candidates[0]).toMatchObject({ id: 'mm_recomp', game: "Majora's Mask Recompiled", source: 'custom-legacy' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
