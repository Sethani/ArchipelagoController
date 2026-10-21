const fs = require('node:fs/promises');
const path = require('node:path');
const { unzipSync } = require('fflate');

const COMPONENT_LABEL = /\b(?:Client|Tracker|Adjuster|Creator|Manager|Tool|Launcher)\s*$/;
const SOURCE_COMPONENT = /\bComponent\s*\(\s*(?:(?:display_name|name)\s*=\s*)?(["'])([^"'\r\n]{2,100})\1/g;

function cleanLabel(value) {
  const label = String(value ?? '').trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
  if (!COMPONENT_LABEL.test(label) || !/[A-Z]/.test(label) || !/[a-z]/.test(label) || !/\s/.test(label) || /[\\/=:<>\[\]{}()]/.test(label)) return '';
  if (/^(?:Launch|Run|Start|This|That|Generates?|Opens?|Creates?)\b/.test(label)) return '';
  return label;
}

function sourceComponents(source) {
  const results = [];
  const text = String(source ?? '');
  const matches = [...text.matchAll(SOURCE_COMPONENT)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const displayName = cleanLabel(match[2]);
    if (!displayName) continue;
    const tail = text.slice(match.index, Math.min(matches[index + 1]?.index ?? text.length, match.index + 1200));
    const type = tail.match(/component_type\s*=\s*(?:Type\.)?([A-Z_]+)/)?.[1]?.toLowerCase() ?? 'unknown';
    const supportsUri = /supports_uri\s*=\s*True\b/.test(tail);
    const gameName = tail.match(/game_name\s*=\s*(["'])([^"'\r\n]{1,100})\1/)?.[2]?.trim();
    results.push({ displayName, type, supportsUri, gameNames: gameName ? [gameName] : [] });
  }
  return results;
}

function compiledComponents(contents) {
  const buffer = Buffer.from(contents);
  const raw = buffer.toString('latin1');
  if (!raw.includes('LauncherComponents') || !raw.includes('Component')) return [];
  const strings = raw.match(/[\x20-\x7e]{4,120}/g) ?? [];
  return strings.map(cleanLabel).filter(Boolean).map((displayName) => ({ displayName, type: 'unknown', supportsUri: false, gameNames: [] }));
}

function componentsFromEntries(entries, fallbackName, origin) {
  let sourceWorld = fallbackName;
  const manifestName = Object.keys(entries).find((name) => /(?:^|\/)archipelago\.json$/i.test(name));
  if (manifestName) {
    try { sourceWorld = JSON.parse(Buffer.from(entries[manifestName]).toString('utf8')).game || sourceWorld; } catch { /* Fall back to package name. */ }
  }
  const components = [];
  for (const [entryName, contents] of Object.entries(entries)) {
    if (/\.py$/i.test(entryName)) components.push(...sourceComponents(Buffer.from(contents).toString('utf8')));
    else if (/\.pyc$/i.test(entryName)) components.push(...compiledComponents(contents));
  }
  return components.map((component) => ({ ...component, sourceWorld, origin }));
}

async function packageComponents(filePath, origin) {
  try {
    const entries = unzipSync(new Uint8Array(await fs.readFile(filePath)));
    return componentsFromEntries(entries, path.basename(filePath, path.extname(filePath)), origin);
  } catch { return []; }
}

async function directoryComponents(directory, sourceWorld, origin, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return []; }
  let resolvedWorld = sourceWorld;
  try { resolvedWorld = JSON.parse(await fs.readFile(path.join(directory, 'archipelago.json'), 'utf8')).game || sourceWorld; } catch { /* Legacy world. */ }
  const results = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await directoryComponents(target, resolvedWorld, origin, depth + 1));
    else if (/\.py$/i.test(entry.name)) {
      try { results.push(...sourceComponents(await fs.readFile(target, 'utf8')).map((item) => ({ ...item, sourceWorld: resolvedWorld, origin }))); } catch { /* Unreadable module. */ }
    } else if (/\.pyc$/i.test(entry.name)) {
      try { results.push(...compiledComponents(await fs.readFile(target)).map((item) => ({ ...item, sourceWorld: resolvedWorld, origin }))); } catch { /* Unreadable module. */ }
    }
  }
  return results;
}

async function inventoryLauncherComponents(installRoot) {
  if (!String(installRoot ?? '').trim()) return [];
  const root = path.resolve(String(installRoot ?? ''));
  const results = [];
  for (const [folder, origin] of [['custom_worlds', 'custom'], [path.join('lib', 'worlds'), 'built-in']]) {
    const directory = path.join(root, folder);
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.apworld')) results.push(...await packageComponents(target, origin));
      else if (entry.isDirectory()) results.push(...await directoryComponents(target, entry.name, origin));
    }
  }
  const unique = new Map();
  for (const component of results) {
    const key = component.displayName.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, component);
    else {
      const existing = unique.get(key);
      existing.supportsUri ||= component.supportsUri;
      existing.gameNames = [...new Set([...(existing.gameNames ?? []), ...(component.gameNames ?? [])])];
    }
  }
  return [...unique.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function resolveLauncherClient(components, game) {
  const normalized = String(game ?? '').trim().toLocaleLowerCase();
  const candidates = components.filter((component) => component.type === 'client' && [component.sourceWorld, ...(component.gameNames ?? [])]
    .some((name) => String(name).trim().toLocaleLowerCase() === normalized));
  const uri = candidates.find((component) => component.supportsUri);
  return uri ? { displayName: uri.displayName, supportsUri: true, mode: 'uri', gameName: uri.gameNames?.[0] || game }
    : candidates[0] ? { displayName: candidates[0].displayName, supportsUri: false, mode: 'patch-only', gameName: candidates[0].gameNames?.[0] || game }
      : { supportsUri: false, mode: 'file-only' };
}

module.exports = { compiledComponents, componentsFromEntries, inventoryLauncherComponents, resolveLauncherClient, sourceComponents };
