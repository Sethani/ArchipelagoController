import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inventoryMinecraftLauncher } = require('./minecraft-launcher.cjs');

describe('Minecraft launcher inventory', () => {
  it('prefers installed NeoForge profiles and records the exact version', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'controller-minecraft-'));
    const minecraftRoot = path.join(root, '.minecraft');
    const launcher = path.join(root, 'Minecraft.exe');
    try {
      await mkdir(minecraftRoot, { recursive: true });
      await writeFile(launcher, 'launcher');
      await writeFile(path.join(minecraftRoot, 'launcher_profiles.json'), JSON.stringify({ profiles: {
        vanilla: { name: 'Latest release', lastVersionId: 'latest-release', lastUsed: '2026-10-18T10:00:00Z' },
        NeoForge: { name: 'NeoForge', lastVersionId: 'neoforge-26.2.0.90', lastUsed: '2026-10-16T10:00:00Z' },
      } }));
      const result = await inventoryMinecraftLauncher({ minecraftRoot, launcherCandidates: [launcher] });
      expect(result.launcherPath).toBe(launcher);
      expect(result.profiles[0]).toMatchObject({ id: 'NeoForge', version: 'neoforge-26.2.0.90', neoForge: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
