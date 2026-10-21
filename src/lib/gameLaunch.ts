import type { GameLaunchAction, GameLaunchProfile, MinecraftLauncherInventory } from '../types';

export const launchProfileKey = (game: string) => game.trim().toLocaleLowerCase();

export function suggestLaunchTemplate(value: string, slot: string, roomUrl: string): string {
  let result = value;
  if (roomUrl) result = result.split(roomUrl).join('{roomUrl}');
  if (slot) result = result.split(slot).join('{slot}');
  result = result.replace(/\b(?:localhost|127\.0\.0\.1|archipelago\.gg):\d{2,5}\b/gi, '{endpoint}');
  return result;
}

export function previewLaunchTemplate(value: string, context: Record<string, string | number | undefined>): string {
  return value.replace(/\{(server|port|endpoint|slot|game|roomUrl|roomFolder|slotFolder|selectedFile)\}/g, (_match, key) => String(context[key] ?? ''));
}

export function emptyLaunchAction(type: GameLaunchAction['type'] = 'steam'): GameLaunchAction {
  return { type, steamMode: 'app', appId: '', sourceModPath: '', path: '', target: '', arguments: '', workingDirectory: '' };
}

export function minecraftLaunchAction(inventory?: MinecraftLauncherInventory): GameLaunchAction {
  const profile = inventory?.profiles.find((item) => item.neoForge) ?? inventory?.profiles[0];
  return {
    type: 'minecraft',
    launcherPath: inventory?.launcherPath ?? '',
    minecraftRoot: inventory?.minecraftRoot ?? '',
    minecraftProfileId: profile?.id ?? '',
    minecraftProfileName: profile?.name ?? '',
    minecraftVersion: profile?.version ?? '',
  };
}

export function emptyLaunchProfile(game: string): GameLaunchProfile {
  return {
    id: crypto.randomUUID(),
    game,
    label: `${game} launch`,
    primary: emptyLaunchAction(),
    updatedAt: new Date().toISOString(),
  };
}
