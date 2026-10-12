const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { unzipSync } = require('fflate');
const YAML = require('yaml');

const INDEX_URL = 'https://raw.githubusercontent.com/silasary/apworlds/main/index.json';
const SHEET_URLS = [
  'https://docs.google.com/spreadsheets/d/1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw/gviz/tq?tqx=out:csv&gid=58422002',
  'https://docs.google.com/spreadsheets/d/1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw/export?format=csv&gid=58422002',
];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const REFRESH_THROTTLE_MS = 30 * 1000;

const SHEET_ALIASES = {
  tmc: 'the minish cap',
  tracker: 'universal tracker',
  lootslime: 'lootslime',
};

const LEGACY_BUILT_IN_GAMES = {
  adventure: 'Adventure',
  alttp: 'A Link to the Past',
  lufia2ac: 'Lufia II Ancient Cave',
  overcooked2: 'Overcooked! 2',
  raft: 'Raft',
  sm64ex: 'Super Mario 64',
  v6: 'VVVVVV',
};

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}

function versionParts(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '').toLowerCase();
  const coreMatch = text.match(/\d+(?:\.\d+)*/);
  const core = (coreMatch?.[0] ?? '0').split('.').map((part) => Number(part) || 0);
  const suffix = text.slice(coreMatch ? coreMatch.index + coreMatch[0].length : 0);
  const stage = /post|rev|hotfix/.test(suffix) ? 4
    : /rc/.test(suffix) ? 2
      : /b(?:eta)?/.test(suffix) ? 1
        : /a(?:lpha)?|dev|pre/.test(suffix) ? 0 : 3;
  const suffixNumber = Number(suffix.match(/\d+/)?.[0] ?? 0);
  return { core, stage, suffixNumber, text };
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference) return difference;
  }
  if (a.stage !== b.stage) return a.stage - b.stage;
  if (a.suffixNumber !== b.suffixNumber) return a.suffixNumber - b.suffixNumber;
  return a.text.localeCompare(b.text);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < String(text).length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function normalizeSheet(csv) {
  const rows = parseCsv(csv);
  const headerIndex = rows.findIndex((row) => row.some((cell) => /(?:^|\s)Game$/i.test(String(cell).trim())));
  if (headerIndex < 0) throw new Error('The community spreadsheet header was not found.');
  const knownHeaders = ['Game', 'Stability', 'PR Status', '18+ / Unrated', 'Links & Downloads', 'Setup Guides', 'Support', 'Disclosures', 'Notes'];
  const headers = rows[headerIndex].map((value) => {
    const text = String(value).trim();
    return knownHeaders.find((header) => text === header || text.endsWith(` ${header}`)) || text;
  });
  return rows.slice(headerIndex + 1).map((values) => Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? '').trim()])))
    .filter((row) => row.Game)
    .map((row) => ({
      game: row.Game,
      stability: ['Stable', 'Unstable', 'Broken on Main'].includes(row.Stability) ? row.Stability : 'Unknown',
      prStatus: row['PR Status'] || '',
      adult: Boolean(row['18+ / Unrated'] && !/^(--|no|false)$/i.test(row['18+ / Unrated'])),
      disclosure: row.Disclosures || '',
      notes: row.Notes || '',
    }));
}

function githubUrls(downloadUrl, tagVersion) {
  const match = String(downloadUrl).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/[^/]+\//i);
  if (!match) return {};
  const sourceUrl = `https://github.com/${match[1]}`;
  const encodedTag = String(tagVersion ?? '').split('/').map(encodeURIComponent).join('/');
  return { sourceUrl, releaseUrl: encodedTag ? `${sourceUrl}/releases/tag/${encodedTag}` : `${sourceUrl}/releases` };
}

function releaseChannel(metadata) {
  const flags = Array.isArray(metadata.flags) ? metadata.flags.map(String) : [];
  if (flags.includes('unready')) return 'Unready';
  if (flags.includes('prerelease') || versionParts(metadata.world_version).stage < 3) return 'Prerelease';
  return 'Release';
}

function normalizeIndex(raw) {
  if (!raw || !Array.isArray(raw.worlds) || typeof raw.meta !== 'object') throw new Error('The APWorld Index format was not recognized.');
  const grouped = new Map();
  for (const item of raw.worlds) {
    const metadata = item?.metadata ?? {};
    const id = String(metadata.id ?? '').trim();
    const url = String(item?.world ?? '').trim();
    const sha256 = String(item?.hash_sha256 ?? '').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(id) || !/^https:\/\//i.test(url) || !/^[a-f0-9]{64}$/.test(sha256)) continue;
    const meta = raw.meta[id] ?? {};
    if (!grouped.has(id)) grouped.set(id, {
      id,
      game: String(meta.game || metadata.game || id),
      description: String(meta.description || ''),
      authors: Array.isArray(meta.authors) ? meta.authors.map(String) : [],
      trackerUrl: String(meta.tracker || meta.tracker_url || ''),
      license: String(meta.license || ''),
      disclosure: String(meta.ai_disclosure || meta.disclosure || ''),
      flags: Array.isArray(meta.flags) ? meta.flags.map(String) : [],
      releases: [],
    });
    const urls = githubUrls(url, metadata.tag_version);
    const entry = grouped.get(id);
    if (!entry.sourceUrl && urls.sourceUrl) entry.sourceUrl = urls.sourceUrl;
    const flags = [...new Set([...(entry.flags ?? []), ...(Array.isArray(metadata.flags) ? metadata.flags.map(String) : [])])];
    entry.releases.push({
      id: sha256,
      version: String(metadata.world_version || metadata.tag_version || 'Unknown'),
      tagVersion: String(metadata.tag_version || metadata.world_version || ''),
      url,
      releaseUrl: urls.releaseUrl || url,
      size: Number(item.size) || 0,
      sha256,
      createdAt: metadata.created_at ? String(metadata.created_at) : undefined,
      minimumApVersion: metadata.minimum_ap_version ? String(metadata.minimum_ap_version) : undefined,
      maximumApVersion: metadata.maximum_ap_version ? String(metadata.maximum_ap_version) : undefined,
      channel: releaseChannel({ ...metadata, flags }),
      flags,
    });
  }
  return [...grouped.values()].map((entry) => ({
    ...entry,
    releases: entry.releases.sort((a, b) => compareVersions(b.version, a.version)),
  })).sort((a, b) => a.game.localeCompare(b.game));
}

function mergeCommunity(entries, sheetRows) {
  const sheet = new Map(sheetRows.map((row) => [normalizeName(row.game), row]));
  return entries.map((entry) => {
    const alias = SHEET_ALIASES[entry.id];
    const community = sheet.get(alias || normalizeName(entry.game));
    const flags = new Set([...(entry.flags ?? []), ...entry.releases.flatMap((release) => release.flags)]);
    return {
      id: entry.id,
      game: entry.game,
      description: entry.description,
      authors: entry.authors,
      sourceUrl: entry.sourceUrl || undefined,
      trackerUrl: entry.trackerUrl || undefined,
      license: entry.license || undefined,
      disclosure: entry.disclosure || community?.disclosure || undefined,
      communityStatus: community?.stability ?? 'Unknown',
      prStatus: community?.prStatus || undefined,
      communityNotes: community?.notes || undefined,
      adult: Boolean(community?.adult || flags.has('after_dark')),
      releases: entry.releases,
    };
  });
}

function safeZipEntries(buffer) {
  if (buffer.byteLength > MAX_PACKAGE_BYTES) throw new Error('The APWorld package is larger than 256 MB.');
  let entries;
  try { entries = unzipSync(new Uint8Array(buffer)); } catch { throw new Error('The selected file is not a readable APWorld ZIP package.'); }
  for (const name of Object.keys(entries)) {
    const normalized = name.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (!normalized || normalized.startsWith('/') || parts.some((part) => part === '..' || part.includes(':') || part.includes('\0'))) {
      throw new Error(`Unsafe path in APWorld package: ${name}`);
    }
  }
  return entries;
}

function manifestInfo(buffer, expectedId) {
  const entries = safeZipEntries(buffer);
  const manifestNames = Object.keys(entries).filter((name) => /(^|\/)archipelago\.json$/i.test(name.replace(/\\/g, '/')));
  if (manifestNames.length !== 1) throw new Error('The APWorld must contain exactly one archipelago.json manifest.');
  const manifestName = manifestNames[0].replace(/\\/g, '/');
  const parts = manifestName.split('/').filter(Boolean);
  if (parts.length !== 2) throw new Error('archipelago.json must be inside the APWorld root folder.');
  const id = parts[0];
  if (!/^[a-zA-Z0-9_]+$/.test(id)) throw new Error('The APWorld root folder must use letters, numbers, and underscores.');
  if (expectedId && id !== expectedId) throw new Error(`Package root ${id} does not match catalog ID ${expectedId}.`);
  let manifest;
  try { manifest = JSON.parse(Buffer.from(entries[manifestNames[0]]).toString('utf8')); } catch { throw new Error('archipelago.json is not valid JSON.'); }
  if (!manifest || typeof manifest.game !== 'string' || !manifest.game.trim()) throw new Error('archipelago.json does not contain a game name.');
  return {
    id,
    game: manifest.game.trim(),
    version: manifest.world_version ? String(manifest.world_version) : undefined,
    minimumApVersion: manifest.minimum_ap_version ? String(manifest.minimum_ap_version) : undefined,
    maximumApVersion: manifest.maximum_ap_version ? String(manifest.maximum_ap_version) : undefined,
    authors: Array.isArray(manifest.authors) ? manifest.authors.map(String) : [],
    sourceUrl: String(manifest.repo_url || manifest.github || ''),
    trackerUrl: typeof manifest.tracker === 'string' ? manifest.tracker : String(manifest.tracker?.url || ''),
    license: String(manifest.license || ''),
    disclosure: String(manifest.ai_disclosure || manifest.disclosure || ''),
  };
}

function legacyPackageInfo(buffer) {
  const entries = safeZipEntries(buffer);
  const initNames = Object.keys(entries).filter((name) => {
    const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length === 2 && parts[1] === '__init__.py';
  });
  if (initNames.length !== 1) throw new Error('The legacy APWorld root module could not be identified safely.');
  const normalized = initNames[0].replace(/\\/g, '/');
  const id = normalized.split('/')[0];
  if (!/^[a-zA-Z0-9_]+$/.test(id)) throw new Error('The APWorld root folder must use letters, numbers, and underscores.');
  const source = Buffer.from(entries[initNames[0]]).toString('utf8');
  const registrations = [...source.matchAll(/^\s*game\s*=\s*(["'])(.+)\1\s*$/gm)]
    .map((match) => match[2].replace(/\\(["'\\])/g, '$1').trim())
    .filter((game) => game && game.length <= 160 && !/[\r\n\0]/.test(game));
  const games = [...new Set(registrations)];
  if (games.length !== 1) throw new Error('The legacy APWorld does not contain one statically readable game registration.');
  return { id, game: games[0] };
}

function compatibility(minimum, maximum, apVersion) {
  if (!apVersion) return 'Unknown';
  if (minimum && compareVersions(apVersion, minimum) < 0) return 'Too old';
  if (maximum && compareVersions(apVersion, maximum) > 0) return 'Too new';
  return 'Compatible';
}

function exactGameKey(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

function editDistance(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    let previous = row[0];
    row[0] = aIndex;
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      const current = row[bIndex];
      row[bIndex] = Math.min(row[bIndex] + 1, row[bIndex - 1] + 1, previous + (a[aIndex - 1] === b[bIndex - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

async function readApVersion(installRoot) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(installRoot, 'manifest.json'), 'utf8'));
    const value = manifest.version ?? manifest.archipelago_version;
    return Array.isArray(value) ? value.join('.') : value ? String(value) : undefined;
  } catch { return undefined; }
}

async function inspectFile(filePath) {
  const buffer = await fs.readFile(filePath);
  const info = manifestInfo(buffer);
  return {
    ...info,
    path: filePath,
    fileName: path.basename(filePath),
    sha256: createHash('sha256').update(buffer).digest('hex'),
    issues: [],
  };
}

async function inventory(installRoot) {
  const root = path.resolve(String(installRoot || ''));
  const apVersion = await readApVersion(root);
  if (!apVersion) return { installed: [], builtIn: [], error: 'Choose a valid Archipelago installation folder.' };
  const installed = [];
  const customRoot = path.join(root, 'custom_worlds');
  try {
    const entries = await fs.readdir(customRoot, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.apworld'))) {
      const filePath = path.join(customRoot, entry.name);
      try { installed.push(await inspectFile(filePath)); }
      catch (error) {
        const buffer = await fs.readFile(filePath).catch(() => null);
        const sha256 = buffer ? createHash('sha256').update(buffer).digest('hex') : '';
        const legacy = buffer ? (() => { try { return legacyPackageInfo(buffer); } catch { return null; } })() : null;
        installed.push({ id: legacy?.id || path.parse(entry.name).name.toLowerCase(), game: legacy?.game || path.parse(entry.name).name, legacyGame: legacy?.game, path: filePath, fileName: entry.name, authors: [], sha256, issues: [error.message] });
      }
    }
  } catch { /* custom_worlds is optional */ }
  const builtIn = [];
  const builtInRoot = path.join(root, 'lib', 'worlds');
  try {
    const entries = await fs.readdir(builtInRoot, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith('_'))) {
      let manifest = {};
      try { manifest = JSON.parse(await fs.readFile(path.join(builtInRoot, entry.name, 'archipelago.json'), 'utf8')); } catch { /* legacy core world */ }
      builtIn.push({ id: entry.name, game: String(manifest.game || entry.name), version: manifest.world_version ? String(manifest.world_version) : undefined, authors: Array.isArray(manifest.authors) ? manifest.authors.map(String) : [] });
    }
    for (const entry of entries.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.apworld'))) {
      try {
        const world = await inspectFile(path.join(builtInRoot, entry.name));
        builtIn.push({ id: world.id, game: world.game, version: world.version, authors: world.authors });
      } catch {
        builtIn.push({ id: path.parse(entry.name).name, game: path.parse(entry.name).name, authors: [] });
      }
    }
  } catch { /* invalid install handled above */ }
  return { installed: installed.sort((a, b) => a.game.localeCompare(b.game)), builtIn: builtIn.sort((a, b) => a.game.localeCompare(b.game)), apVersion };
}

function createApWorldService({ app, net, shell, isBusy = () => false }) {
  const cacheFile = () => path.join(app.getPath('userData'), 'apworld-catalog.json');
  let lastRefreshAttempt = 0;
  let refreshPromise = null;

  async function readCache() {
    try { return JSON.parse(await fs.readFile(cacheFile(), 'utf8')); } catch { return { indexEntries: [], sheetRows: [], sources: [] }; }
  }

  async function writeCache(cache) {
    await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
    await fs.writeFile(cacheFile(), JSON.stringify(cache), 'utf8');
  }

  function resultFrom(cache) {
    const updatedAt = cache.updatedAt;
    return {
      entries: mergeCommunity(cache.indexEntries || [], cache.sheetRows || []),
      sources: cache.sources || [],
      updatedAt,
      stale: !updatedAt || Date.now() - new Date(updatedAt).getTime() > DAY_MS || (cache.sources || []).some((source) => !source.ok),
    };
  }

  async function fetchText(url) {
    const response = await net.fetch(url, { headers: { Accept: 'application/json,text/csv,text/plain,*/*', 'User-Agent': 'Mozilla/5.0 ArchipelagoController/0.1' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  async function fetchFirst(urls) {
    let lastError;
    for (const url of urls) {
      try { return await fetchText(url); } catch (error) { lastError = error; }
    }
    throw lastError || new Error('No source URL was available.');
  }

  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    if (force && Date.now() - lastRefreshAttempt < REFRESH_THROTTLE_MS) return resultFrom(await readCache());
    lastRefreshAttempt = Date.now();
    refreshPromise = (async () => {
      const previous = await readCache();
      const now = new Date().toISOString();
      const [indexResult, sheetResult] = await Promise.allSettled([fetchText(INDEX_URL), fetchFirst(SHEET_URLS)]);
      let indexEntries = previous.indexEntries || [];
      let sheetRows = previous.sheetRows || [];
      const sources = [];
      if (indexResult.status === 'fulfilled') {
        try { indexEntries = normalizeIndex(JSON.parse(indexResult.value)); sources.push({ source: 'index', ok: true, updatedAt: now }); }
        catch (error) { sources.push({ source: 'index', ok: false, updatedAt: previous.sources?.find((item) => item.source === 'index')?.updatedAt, error: error.message }); }
      } else sources.push({ source: 'index', ok: false, updatedAt: previous.sources?.find((item) => item.source === 'index')?.updatedAt, error: indexResult.reason?.message || 'Unavailable' });
      if (sheetResult.status === 'fulfilled') {
        try { sheetRows = normalizeSheet(sheetResult.value); sources.push({ source: 'spreadsheet', ok: true, updatedAt: now }); }
        catch (error) { sources.push({ source: 'spreadsheet', ok: false, updatedAt: previous.sources?.find((item) => item.source === 'spreadsheet')?.updatedAt, error: error.message }); }
      } else sources.push({ source: 'spreadsheet', ok: false, updatedAt: previous.sources?.find((item) => item.source === 'spreadsheet')?.updatedAt, error: sheetResult.reason?.message || 'Unavailable' });
      const cache = { indexEntries, sheetRows, sources, updatedAt: sources.some((source) => source.ok) ? now : previous.updatedAt };
      await writeCache(cache);
      return resultFrom(cache);
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function getCatalog(options = {}) {
    const cache = await readCache();
    const maxAge = Number(options.maxAgeMs ?? DAY_MS);
    if (!cache.updatedAt || Date.now() - new Date(cache.updatedAt).getTime() > maxAge) return refresh(false);
    return resultFrom(cache);
  }

  async function gameCandidates(installRoot) {
    const current = await inventory(installRoot);
    if (current.error) return { ...current, candidates: [] };
    const candidates = [];
    for (const world of current.installed.filter((item) => item.issues.length === 0)) {
      candidates.push({
        id: world.id,
        game: world.game,
        source: 'custom',
        version: world.version,
        signature: `custom:${world.id}:${world.sha256}`,
        compatibility: compatibility(world.minimumApVersion, world.maximumApVersion, current.apVersion),
      });
    }
    for (const world of current.builtIn) {
      const game = LEGACY_BUILT_IN_GAMES[world.id] || world.game;
      if (!game || ['generic', '_bizhawk', '_sc2common'].includes(world.id)) continue;
      candidates.push({
        id: world.id,
        game,
        source: 'built-in',
        version: world.version,
        signature: `built-in:${current.apVersion}:${world.id}:${world.version || ''}`,
        compatibility: 'Compatible',
      });
    }
    const builtInById = new Map(current.builtIn.map((world) => [exactGameKey(world.id), world]));
    for (const world of current.installed.filter((item) => item.issues.length > 0)) {
      const bundled = builtInById.get(exactGameKey(world.id));
      const game = world.legacyGame || (bundled ? LEGACY_BUILT_IN_GAMES[bundled.id] || bundled.game : '');
      if (!game) continue;
      candidates.push({
        id: world.id,
        game,
        source: 'custom-legacy',
        signature: `custom-legacy:${world.id}:${world.sha256 || world.issues.join('|')}`,
        compatibility: 'Unknown',
      });
    }
    try {
      const templateRoot = path.join(path.resolve(String(installRoot || '')), 'Players', 'Templates');
      const templates = await fs.readdir(templateRoot, { withFileTypes: true });
      for (const entry of templates.filter((item) => item.isFile() && /\.ya?ml$/i.test(item.name))) {
        let game = path.basename(entry.name, path.extname(entry.name));
        try {
          const document = YAML.parse(await fs.readFile(path.join(templateRoot, entry.name), 'utf8'));
          if (typeof document?.game === 'string') game = document.game.trim();
        } catch { /* the generated filename remains a useful legacy hint */ }
        if (!game || candidates.some((item) => exactGameKey(item.game) === exactGameKey(game))) continue;
        candidates.push({ id: `template:${entry.name}`, game, source: 'legacy-template', signature: `template:${current.apVersion}:${game}`, compatibility: 'Unknown' });
      }
    } catch { /* generated templates are optional */ }
    return { ...current, candidates };
  }

  async function resolveGames({ installRoot, games }) {
    if (!Array.isArray(games) || games.length > 500) throw new Error('Invalid YAML game list.');
    const { candidates, error } = await gameCandidates(installRoot);
    if (error) throw new Error(error);
    return games.map((rawGame) => {
      const game = String(rawGame ?? '').trim();
      const exact = candidates.filter((item) => exactGameKey(item.game) === exactGameKey(game));
      const authoritative = exact.filter((item) => item.source !== 'legacy-template');
      const usable = authoritative.filter((item) => item.compatibility === 'Compatible');
      const providerIds = new Set(authoritative.map((item) => exactGameKey(item.id)));
      const hasCustomOverride = authoritative.some((item) => item.source === 'custom' || item.source === 'custom-legacy')
        && authoritative.some((item) => item.source === 'built-in') && providerIds.size === 1;
      let status;
      let matched = authoritative.length ? authoritative : exact;
      if (hasCustomOverride) status = 'Installed with override';
      else if (authoritative.length > 1) status = 'Ambiguous';
      else if (authoritative.length === 1) status = authoritative[0].source === 'custom-legacy' ? 'Possible legacy match' : usable.length ? 'Installed' : 'Installed but incompatible';
      else if (exact.length) status = 'Possible legacy match';
      else status = 'Missing';
      let suggestion;
      if (status === 'Missing' && game) {
        const suggestions = candidates.map((item) => ({ game: item.game, distance: editDistance(game, item.game) })).sort((a, b) => a.distance - b.distance || a.game.localeCompare(b.game));
        const closest = suggestions[0];
        if (closest && closest.distance <= Math.max(3, Math.ceil(normalizeName(game).length * 0.25))) suggestion = closest.game;
      }
      const signature = matched.length ? matched.map((item) => item.signature).sort().join('|') : `missing:${exactGameKey(game)}`;
      const message = status === 'Installed' ? `${matched[0].game} is installed from ${matched[0].source}.`
        : status === 'Installed with override' ? `${game} has custom and bundled providers with the same world ID. Archipelago will select the active provider during validation.`
        : status === 'Installed but incompatible' ? `${matched[0].game} does not declare compatibility with this Archipelago version.`
          : status === 'Possible legacy match' ? matched[0].source === 'custom-legacy' ? `${matched[0].game} is registered by a legacy custom package without a valid manifest. Run AP validation to confirm it.` : `${matched[0].game} appears in generated templates but has no authoritative manifest match.`
            : status === 'Ambiguous' ? `${game} is provided by multiple installed worlds.`
              : suggestion ? `${game} is not installed. Did you mean ${suggestion}?` : `${game || 'Unknown game'} is not installed.`;
      return { game, status, signature, candidates: matched, suggestion, message };
    });
  }

  async function validateRoot(installRoot) {
    const root = path.resolve(String(installRoot || ''));
    if (!await readApVersion(root)) throw new Error('Choose a valid Archipelago installation folder.');
    const customRoot = path.join(root, 'custom_worlds');
    await fs.mkdir(customRoot, { recursive: true });
    return customRoot;
  }

  async function placePackage(customRoot, info, buffer) {
    let target = path.join(customRoot, `${info.id}.apworld`);
    try {
      const entries = await fs.readdir(customRoot, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.apworld'))) {
        const candidate = path.join(customRoot, entry.name);
        try {
          if ((await inspectFile(candidate)).id === info.id) { target = candidate; break; }
        } catch { /* malformed packages cannot be matched by manifest ID */ }
      }
    } catch { /* validateRoot created this directory */ }
    const stage = path.join(customRoot, `.${info.id}-${randomUUID()}.tmp`);
    const backup = path.join(customRoot, `.${info.id}-${randomUUID()}.backup`);
    await fs.writeFile(stage, buffer, { flag: 'wx' });
    let hadPrevious = false;
    try {
      hadPrevious = await fs.access(target).then(() => true).catch(() => false);
      if (hadPrevious) await fs.rename(target, backup);
      await fs.rename(stage, target);
    } catch (error) {
      await fs.rm(stage, { force: true }).catch(() => {});
      if (hadPrevious) await fs.rename(backup, target).catch(() => {});
      throw error;
    }
    let warning;
    if (hadPrevious) {
      try { await shell.trashItem(backup); }
      catch { warning = `The previous package was retained at ${backup}.`; }
    }
    return { warning };
  }

  async function install({ installRoot, worldId, releaseId }) {
    if (isBusy()) throw new Error('Stop the local host or generator before changing APWorlds.');
    if (!/^[a-z0-9_]+$/.test(String(worldId))) throw new Error('Invalid APWorld ID.');
    if (!/^[a-f0-9]{64}$/.test(String(releaseId))) throw new Error('Invalid release ID.');
    const cache = await readCache();
    const entry = (cache.indexEntries || []).find((item) => item.id === worldId);
    const release = entry?.releases.find((item) => item.id === releaseId);
    if (!release) throw new Error('That indexed release is no longer available in the local catalog. Refresh and try again.');
    const response = await net.fetch(release.url);
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (release.size && buffer.length !== release.size) throw new Error('Downloaded package size does not match the index.');
    const hash = createHash('sha256').update(buffer).digest('hex');
    if (hash !== release.sha256) throw new Error('Downloaded package checksum does not match the APWorld Index.');
    const info = manifestInfo(buffer, worldId);
    const customRoot = await validateRoot(installRoot);
    return { ok: true, ...(await placePackage(customRoot, info, buffer)) };
  }

  async function importLocal({ installRoot, sourcePath }) {
    if (isBusy()) throw new Error('Stop the local host or generator before changing APWorlds.');
    const source = path.resolve(String(sourcePath || ''));
    if (path.extname(source).toLowerCase() !== '.apworld') throw new Error('Choose a .apworld file.');
    const buffer = await fs.readFile(source);
    const info = manifestInfo(buffer);
    const customRoot = await validateRoot(installRoot);
    const placed = await placePackage(customRoot, info, buffer);
    const apVersion = await readApVersion(installRoot);
    const state = compatibility(info.minimumApVersion, info.maximumApVersion, apVersion);
    const warning = state !== 'Compatible' && state !== 'Unknown' ? `Installed, but this world is ${state.toLowerCase()} for Archipelago ${apVersion}.` : placed.warning;
    return { ok: true, warning };
  }

  async function remove({ installRoot, worldId }) {
    if (isBusy()) throw new Error('Stop the local host or generator before changing APWorlds.');
    const customRoot = await validateRoot(installRoot);
    const found = (await inventory(installRoot)).installed.find((item) => item.id === worldId);
    if (!found) throw new Error('The installed APWorld could not be found.');
    const resolved = path.resolve(found.path);
    if (path.dirname(resolved).toLowerCase() !== path.resolve(customRoot).toLowerCase()) throw new Error('Refusing to remove a file outside custom_worlds.');
    await shell.trashItem(resolved);
    return { ok: true };
  }

  return { getCatalog, refresh: () => refresh(true), inventory, resolveGames, install, importLocal, remove };
}

module.exports = {
  createApWorldService,
  compareVersions,
  compatibility,
  manifestInfo,
  legacyPackageInfo,
  mergeCommunity,
  normalizeIndex,
  normalizeSheet,
  parseCsv,
  editDistance,
};
