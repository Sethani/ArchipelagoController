import type { Settings } from '../types';

export const MAIN_PATH_TOKEN = '{main}';
export const HOSTED_PATH_TOKEN = '{hosted}';

export type MainRelativeSetting = 'importSource' | 'libraryPath' | 'outputRoot' | 'hostedSessionsPath';

export const mainRelativeSettings: MainRelativeSetting[] = ['importSource', 'libraryPath', 'outputRoot', 'hostedSessionsPath'];

function normalized(path: string): string {
  return path.trim().replace(/\//g, '\\').replace(/\\+$/, '');
}

export function resolveMainPath(value: string, installRoot: string): string {
  const match = value.trim().match(/^\{main\}(?:[\\/](.*))?$/i);
  if (!match) return value;
  const root = normalized(installRoot);
  if (!root) return '';
  const suffix = (match[1] ?? '').replace(/[\\/]+/g, '\\');
  return suffix ? `${root}\\${suffix}` : root;
}

export function resolveStoragePath(value: string, installRoot: string, hostedRoot: string): string {
  const hostedMatch = value.trim().match(/^\{hosted\}(?:[\\/](.*))?$/i);
  if (!hostedMatch) return resolveMainPath(value, installRoot);
  const root = normalized(resolveMainPath(hostedRoot, installRoot));
  if (!root) return '';
  const suffix = (hostedMatch[1] ?? '').replace(/[\\/]+/g, '\\');
  return suffix ? `${root}\\${suffix}` : root;
}

export function tokenizeMainPath(value: string, installRoot: string): string {
  const candidate = normalized(value);
  const root = normalized(installRoot);
  if (!candidate || !root || /^\{main\}(?:[\\/]|$)/i.test(candidate)) return value;

  const candidateLower = candidate.toLowerCase();
  const rootLower = root.toLowerCase();
  if (candidateLower === rootLower) return MAIN_PATH_TOKEN;
  if (!candidateLower.startsWith(`${rootLower}\\`)) return value;
  return `${MAIN_PATH_TOKEN}\\${candidate.slice(root.length + 1)}`;
}

export function migrateMainRelativeSettings(settings: Settings): Settings {
  const migrated = { ...settings };
  for (const key of mainRelativeSettings) migrated[key] = tokenizeMainPath(migrated[key], settings.installRoot);
  return migrated;
}
