import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import launch from './game-launch.cjs';

describe('game launch profiles', () => {
  const context = {
    server: 'archipelago.gg', port: 45678, endpoint: 'archipelago.gg:45678', slot: 'Sethiduck_V',
    game: 'VVVVVV', roomUrl: 'https://archipelago.gg/room/test', roomFolder: 'C:\\Rooms\\Test',
    slotFolder: 'C:\\Rooms\\Test\\play\\Sethiduck_V', selectedFile: 'C:\\Rooms\\Test\\randomizer.exe',
  };

  it('fills live room values without changing unrelated text', () => {
    expect(launch.interpolate('-v6ap_name {slot} -v6ap_ip {endpoint}', context))
      .toBe('-v6ap_name Sethiduck_V -v6ap_ip archipelago.gg:45678');
  });

  it('splits quoted program arguments', () => {
    expect(launch.splitArguments('--name "Sethi Duck" --server archipelago.gg:4')).toEqual(['--name', 'Sethi Duck', '--server', 'archipelago.gg:4']);
  });

  it('launches Steam with encoded dynamic arguments', async () => {
    const openExternal = vi.fn();
    await launch.launchAction({ type: 'steam', appId: '70300', arguments: '-v6ap_name {slot} -v6ap_ip {endpoint}' }, context, { openExternal });
    expect(openExternal).toHaveBeenCalledWith(`steam://run/70300//${encodeURIComponent('-v6ap_name Sethiduck_V -v6ap_ip archipelago.gg:45678')}/`);
  });

  it('rejects unsafe URL protocols', async () => {
    await expect(launch.launchAction({ type: 'url', target: 'file:///secret' }, context, { openExternal: vi.fn() }))
      .rejects.toThrow('not allowed');
  });

  it('turns Steam and program shortcuts into editable actions', () => {
    expect(launch.actionFromShortcut({ target: 'steam://rungameid/16657981660565865068' })).toMatchObject({ type: 'steam', steamMode: 'game', appId: '16657981660565865068' });
    expect(launch.actionFromShortcut({ target: 'C:\\Tools\\r2modman.exe', args: '--profile Unfair', cwd: 'C:\\Tools' }))
      .toEqual({ type: 'program', path: 'C:\\Tools\\r2modman.exe', arguments: '--profile Unfair', workingDirectory: 'C:\\Tools' });
  });

  it('preserves the full ID route required by Steam shortcuts and Source mods', async () => {
    const openExternal = vi.fn();
    await launch.launchAction({ type: 'steam', steamMode: 'game', appId: '16657981660565865068' }, context, { openExternal });
    expect(openExternal).toHaveBeenCalledWith('steam://rungameid/16657981660565865068');
  });

  it('validates Source mods as a distinct Steam target', () => {
    expect(launch.validateAction({ type: 'steam', steamMode: 'source', appId: '620', sourceModPath: 'C:\\Steam\\steamapps\\sourcemods\\Portal2Archipelago', arguments: '-netconport 3000' }))
      .toMatchObject({ steamMode: 'source', appId: '620', sourceModPath: 'C:\\Steam\\steamapps\\sourcemods\\Portal2Archipelago' });
  });

  it('launches a Source mod through its base app and game folder', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'controller-source-mod-'));
    await fs.writeFile(path.join(folder, 'GameInfo.txt'), 'SteamAppId 620');
    const openExternal = vi.fn();
    try {
      await launch.launchAction({ type: 'steam', steamMode: 'source', appId: '620', sourceModPath: folder, arguments: '-netconport 3000' }, context, { openExternal });
      expect(openExternal).toHaveBeenCalledWith(`steam://run/620//${encodeURIComponent(`-game "${folder}" -netconport 3000`)}/`);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('defers manual companions until the explicit second stage', async () => {
    const openExternal = vi.fn();
    const profile = {
      id: 'witness', game: 'The Witness', label: 'Witness', companionMode: 'manual', companionLabel: 'Run randomizer',
      primary: { type: 'steam', appId: '210970' }, companion: { type: 'url', target: 'https://example.test/randomizer' },
    };
    const first = await launch.launchProfile(profile, context, { openExternal }, 'primary');
    expect(first).toMatchObject({ deferred: true, launched: ['Steam app 210970'] });
    expect(openExternal).toHaveBeenCalledTimes(1);
    const second = await launch.launchProfile(profile, context, { openExternal }, 'companion');
    expect(second.launched).toEqual(['https://example.test/randomizer']);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('opens a verified Minecraft launcher profile', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'controller-minecraft-action-'));
    const launcherPath = path.join(root, 'Minecraft.exe');
    const version = 'neoforge-26.2.0.90';
    await fs.mkdir(path.join(root, 'versions', version), { recursive: true });
    await fs.writeFile(launcherPath, 'launcher');
    await fs.writeFile(path.join(root, 'launcher_profiles.json'), JSON.stringify({ profiles: { NeoForge: { lastVersionId: version } } }));
    await fs.writeFile(path.join(root, 'versions', version, `${version}.json`), '{}');
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    try {
      const result = await launch.launchAction({ type: 'minecraft', launcherPath, minecraftRoot: root, minecraftProfileId: 'NeoForge', minecraftProfileName: 'NeoForge', minecraftVersion: version }, context, { spawn });
      expect(result).toBe('Minecraft Launcher opened · select NeoForge and press Play');
      expect(spawn).toHaveBeenCalledWith(launcherPath, [], expect.objectContaining({ cwd: root, detached: true }));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
