const fs = require('node:fs/promises');
const path = require('node:path');
const { unzipSync } = require('fflate');

function stripJsonComments(source) {
  const text = String(source ?? '').replace(/^\uFEFF/, '');
  let result = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = '';
      continue;
    }
    if (current === '"' || current === "'") { quote = current; result += current; continue; }
    if (current === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < text.length - 1 && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    result += current;
  }
  return result.replace(/,\s*([}\]])/g, '$1');
}

function parseManifest(source, filePath) {
  const manifest = JSON.parse(stripJsonComments(source));
  const uid = String(manifest.package_uid ?? '').trim();
  const gameName = String(manifest.game_name ?? '').trim();
  if (!uid || !gameName) throw new Error('Manifest has no package_uid or game_name.');
  const variants = Object.entries(manifest.variants ?? {}).map(([id, value]) => ({
    id,
    name: String(value?.display_name ?? id),
    supportsAp: Array.isArray(value?.flags) && value.flags.includes('ap'),
  }));
  return {
    uid, gameName, name: String(manifest.name ?? gameName), version: String(manifest.package_version ?? ''),
    filePath, variants,
  };
}

function versionParts(value) {
  return String(value).split(/[^0-9]+/).filter(Boolean).map(Number);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return String(left).localeCompare(String(right));
}

async function inventoryPopTracker(executablePath) {
  const executable = path.resolve(String(executablePath ?? ''));
  if (!executable || path.extname(executable).toLowerCase() !== '.exe') throw new Error('Configure the PopTracker executable first.');
  await fs.access(executable);
  const roots = [path.join(path.dirname(executable), 'packs')];
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE, 'PopTracker', 'packs'));
    roots.push(path.join(process.env.USERPROFILE, 'Documents', 'PopTracker', 'packs'));
    roots.push(path.join(process.env.USERPROFILE, 'Documents', 'EmoTracker', 'packs'));
    roots.push(path.join(process.env.USERPROFILE, 'EmoTracker', 'packs'));
  }
  const found = [];
  const errors = [];
  for (const root of roots) {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const filePath = path.join(root, entry.name);
      if (!entry.isDirectory() && !(entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))) continue;
      try {
        if (entry.isDirectory()) {
          const manifestPath = path.join(filePath, 'manifest.json');
          found.push(parseManifest(await fs.readFile(manifestPath, 'utf8'), filePath));
        } else {
          const archive = unzipSync(new Uint8Array(await fs.readFile(filePath)));
          const manifestName = Object.keys(archive).find((name) => /(?:^|\/)manifest\.json$/i.test(name));
          if (!manifestName) continue;
          found.push(parseManifest(Buffer.from(archive[manifestName]).toString('utf8'), filePath));
        }
      } catch (error) { errors.push(`${entry.name}: ${error.message}`); }
    }
  }
  const latest = new Map();
  for (const pack of found) {
    const existing = latest.get(pack.uid.toLocaleLowerCase());
    if (!existing || compareVersions(pack.version, existing.version) > 0) latest.set(pack.uid.toLocaleLowerCase(), pack);
  }
  return { packs: [...latest.values()].sort((a, b) => a.gameName.localeCompare(b.gameName)), errors };
}

function popTrackerArgs(pack, variant, connection) {
  const selected = pack.variants.find((item) => item.id === variant);
  if (!selected?.supportsAp) throw new Error('Choose an Archipelago-capable PopTracker variant.');
  const args = ['--load-pack', pack.uid];
  if (pack.version) args.push('--pack-version', pack.version);
  args.push('--pack-variant', variant, '--ap-host', connection.host, '--ap-slot', connection.slot);
  if (connection.password) args.push('--ap-password', connection.password);
  return args;
}

module.exports = { compareVersions, inventoryPopTracker, parseManifest, popTrackerArgs, stripJsonComments };
