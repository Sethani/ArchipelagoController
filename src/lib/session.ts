import { parse, stringify } from 'yaml';
import type { HostSettings, Template } from '../types';

const GAME_KEYS = ['game'];
const SLOT_KEYS = ['name', 'slot', 'player', 'player_name'];

export function compactGameName(value: string): string {
  return value
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((word) => word.length > 1 && word === word.toUpperCase() ? word : word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join('') || 'UnknownGame';
}

export function gameCode(game: string): string {
  const known: Record<string, string> = {
    'A Link to the Past': 'ALTTP',
    'Links Awakening DX': 'LADX',
    'Lootslime': 'LS',
    'Minecraft': 'MC',
    'Ocarina of Time': 'OOT',
    'Super Metroid': 'SM',
    'Stardew Valley': 'SV',
    'The Minish Cap': 'TMC',
    'Unfair Flips': 'UF',
  };
  if (known[game]) return known[game];
  const words = game.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [game];
  return words.map((word) => word[0]).join('').toUpperCase().slice(0, 8) || 'GAME';
}

export function normalizeLegacySlotName(fileName: string, filePath: string, slotName: string): string {
  const stemParts = fileName.replace(/\.ya?ml$/i, '').split('_');
  if (/[\\/]Players[\\/]Temp[\\/]/i.test(filePath)) {
    const prefix = stemParts[0];
    return slotName.toLowerCase() === prefix.toLowerCase() || slotName.toLowerCase().startsWith(`${prefix.toLowerCase()}_`)
      ? prefix
      : slotName;
  }
  if (/[\\/]Players[\\/]ControllerLibrary[\\/]/i.test(filePath) && stemParts.length > 1) {
    const legacySuffix = `_${stemParts.at(-1)}`;
    if (slotName.toLowerCase().endsWith(legacySuffix.toLowerCase())) return slotName.slice(0, -legacySuffix.length);
  }
  return slotName;
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return '';
}

export function inspectYaml(file: PickedYaml): Template {
  const errors: string[] = [];
  let document: Record<string, unknown> = {};
  try {
    const parsed = parse(file.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) errors.push('YAML root must be a mapping');
    else document = parsed as Record<string, unknown>;
  } catch (error) {
    errors.push(error instanceof Error ? error.message.split('\n')[0] : 'Unable to parse YAML');
  }

  const game = readString(document, GAME_KEYS) || 'Unknown game';
  const rawSlotName = readString(document, SLOT_KEYS);
  const slotName = normalizeLegacySlotName(file.name, file.path, rawSlotName);
  if (!slotName) errors.push('Missing player or slot name');
  if (!readString(document, GAME_KEYS)) errors.push('Missing game');

  const stem = file.name.replace(/\.ya?ml$/i, '');
  const [nameGame, ...descriptionParts] = stem.split('_');
  const expectedGame = compactGameName(game);
  if (game !== 'Unknown game' && nameGame.toLowerCase() !== expectedGame.toLowerCase()) {
    errors.push(`Filename should start with ${expectedGame}_`);
  }

  return {
    id: crypto.randomUUID(),
    fileName: file.name,
    path: file.path,
    sourcePath: file.path,
    content: file.content,
    game,
    description: descriptionParts.join(' ') || 'Imported',
    slotName: slotName || 'Unnamed player',
    importedAt: new Date().toISOString(),
    errors,
  };
}

export function yamlFingerprint(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

export function validationFingerprint(content: string): string {
  const normalized = yamlFingerprint(content);
  let hash = 14695981039346656037n;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= BigInt(normalized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
}

export type PreparedTemplate = Template & {
  sourceSlotName: string;
  resolvedSlotName: string;
  changed: boolean;
  preparedContent: string;
};

export function prepareTemplates(templates: Template[]): PreparedTemplate[] {
  const totals = new Map<string, number>();
  templates.forEach(({ slotName }) => totals.set(slotName.toLowerCase(), (totals.get(slotName.toLowerCase()) ?? 0) + 1));
  const used = new Set<string>();

  return templates.map((template) => {
    let resolved = template.slotName;
    if ((totals.get(template.slotName.toLowerCase()) ?? 0) > 1) {
      const base = `${template.slotName}_${gameCode(template.game)}`;
      resolved = base;
      let suffix = 2;
      while (used.has(resolved.toLowerCase())) resolved = `${base}${suffix++}`;
    }
    used.add(resolved.toLowerCase());
    const parsed = parse(template.content) as Record<string, unknown>;
    const key = SLOT_KEYS.find((candidate) => typeof parsed[candidate] === 'string') ?? 'name';
    const sourceSlotName = typeof parsed[key] === 'string' ? parsed[key] as string : template.slotName;
    const changed = resolved !== sourceSlotName;
    if (changed) parsed[key] = resolved;
    return { ...template, sourceSlotName, resolvedSlotName: resolved, changed, preparedContent: changed ? stringify(parsed) : template.content };
  });
}

export function contentWithSlotName(content: string, slotName: string): string {
  const parsed = parse(content) as Record<string, unknown>;
  const key = SLOT_KEYS.find((candidate) => typeof parsed[candidate] === 'string') ?? 'name';
  parsed[key] = slotName;
  return stringify(parsed);
}

export function exportedYamlName(template: Template, playerName: string): string {
  const label = template.description.replace(/[^a-z0-9]+/gi, '') || 'Default';
  return `${compactGameName(template.game)}_${compactGameName(playerName)}_${label}.yaml`;
}

export function hostDocument(settings: HostSettings): Record<string, unknown> {
  let advanced: Record<string, unknown> = {};
  try { advanced = (parse(settings.raw) as Record<string, unknown>) ?? {}; } catch { /* validated separately */ }
  const document = JSON.parse(JSON.stringify(settings.document ?? {})) as Record<string, unknown>;
  const storedServer = document.server_options && typeof document.server_options === 'object' && !Array.isArray(document.server_options)
    ? document.server_options as Record<string, unknown> : {};
  document.server_options = {
      ...advanced,
      ...storedServer,
      host: settings.host || null,
      port: settings.port,
      password: null,
      server_password: null,
      savefile: settings.savefile || null,
      auto_shutdown: settings.autoShutdown,
      loglevel: settings.logLevel,
  };
  return document;
}

export function hostYaml(settings: HostSettings): string {
  return stringify(hostDocument(settings));
}

export function validateRawHostYaml(raw: string): string | null {
  try {
    const result = parse(raw);
    return result === null || (typeof result === 'object' && !Array.isArray(result)) ? null : 'Advanced YAML must be a mapping.';
  } catch (error) {
    return error instanceof Error ? error.message.split('\n')[0] : 'Invalid advanced YAML';
  }
}

export function suggestedFileName(template: Template): string {
  const description = template.description.replace(/[^a-z0-9]+/gi, '') || 'Imported';
  return `${compactGameName(template.game)}_${description}.yaml`;
}
