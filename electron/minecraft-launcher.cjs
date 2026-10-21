const fs = require('node:fs/promises');
const path = require('node:path');

async function firstExisting(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (await fs.access(candidate).then(() => true).catch(() => false)) return path.resolve(candidate);
  }
  return '';
}

async function inventoryMinecraftLauncher(options = {}) {
  const appData = options.appData || process.env.APPDATA || '';
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || '';
  const minecraftRoot = options.minecraftRoot || path.join(appData, '.minecraft');
  const profilePath = options.profilePath || path.join(minecraftRoot, 'launcher_profiles.json');
  const systemDrive = process.env.SystemDrive || 'C:';
  const launcherPath = await firstExisting(options.launcherCandidates || [
    path.join(systemDrive, 'XboxGames', 'Minecraft Launcher', 'Content', 'Minecraft.exe'),
    path.join(process.env.ProgramFiles || '', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    path.join(localAppData, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
  ]);
  let document;
  try { document = JSON.parse(await fs.readFile(profilePath, 'utf8')); }
  catch (error) {
    return { launcherPath, minecraftRoot, profiles: [], error: `Minecraft profiles could not be read: ${error.message}` };
  }
  const profiles = Object.entries(document.profiles || {}).map(([id, value]) => ({
    id,
    name: String(value?.name || value?.lastVersionId || id),
    version: String(value?.lastVersionId || ''),
    gameDirectory: String(value?.gameDir || minecraftRoot),
    lastUsed: String(value?.lastUsed || ''),
    neoForge: /neoforge/i.test(`${value?.name || ''} ${value?.lastVersionId || ''}`),
  })).sort((left, right) => Number(right.neoForge) - Number(left.neoForge) || right.lastUsed.localeCompare(left.lastUsed) || left.name.localeCompare(right.name));
  return { launcherPath, minecraftRoot: path.resolve(minecraftRoot), profilePath: path.resolve(profilePath), profiles };
}

module.exports = { firstExisting, inventoryMinecraftLauncher };
