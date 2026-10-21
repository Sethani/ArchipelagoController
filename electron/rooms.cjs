const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { unzipSync, zipSync } = require('fflate');

const ROOM_HOST = 'archipelago.gg';
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

function parseRoomUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw new Error('Enter a valid Archipelago room link.'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== ROOM_HOST) throw new Error('Only https://archipelago.gg room links are supported.');
  const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{6,100})\/?$/);
  if (!match || url.search || url.hash) throw new Error('Use a canonical https://archipelago.gg/room/... link.');
  return { id: match[1], url: `https://${ROOM_HOST}/room/${match[1]}`, origin: `https://${ROOM_HOST}` };
}

function parseControllerInvite(raw) {
  let value = String(raw ?? '').trim();
  if (/^archipelago-controller:\/\/join/i.test(value)) {
    const invite = new URL(value);
    value = invite.searchParams.get('url') ?? '';
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid Controller room invitation.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Controller room links must use HTTP or HTTPS.');
  const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{6,100})\/?$/);
  if (!match) throw new Error('This is not a Controller room invitation.');
  url.hash = '';
  url.search = '';
  return { id: match[1], url: url.toString().replace(/\/$/, ''), origin: url.origin };
}

function endpointFromStatus(raw) {
  const host = String(raw?.endpoint?.host ?? '').trim();
  const port = Number(raw?.endpoint?.port);
  return host && Number.isInteger(port) && port > 0 && port <= 65535
    ? { host, port, secure: Boolean(raw.endpoint.secure) }
    : undefined;
}

async function refreshControllerRoom(net, rawUrl) {
  const room = parseControllerInvite(rawUrl);
  const response = await net.fetch(`${room.origin}/api/controller/v1/room/${room.id}/status`);
  if (!response.ok) throw new Error(`Controller room returned HTTP ${response.status}.`);
  const raw = await response.json();
  if (Number(raw.apiVersion) !== 1) throw new Error(`Controller room API ${raw.apiVersion ?? 'unknown'} is not supported.`);
  const endpoint = endpointFromStatus(raw);
  return {
    roomId: room.id, url: room.url, trackerId: undefined, lastPort: endpoint?.port, endpoint,
    refreshedAt: new Date().toISOString(), stale: false,
    slots: (Array.isArray(raw.slots) ? raw.slots : []).map((slot) => ({
      slot: Number(slot.slot), name: String(slot.name ?? `Slot ${slot.slot}`), game: String(slot.game ?? 'Unknown'),
      downloadAvailable: Array.isArray(slot.files) && slot.files.length > 0,
    })),
  };
}

function safeName(value, fallback = 'Room') {
  const result = String(value ?? '').trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/[. ]+$/g, '').slice(0, 80);
  return result || fallback;
}

function inside(root, candidate) {
  const base = path.resolve(String(root ?? ''));
  const target = path.resolve(String(candidate ?? ''));
  if (!base || (target !== base && !target.startsWith(`${base}${path.sep}`))) throw new Error('Room path is outside the configured Rooms folder.');
  return target;
}

function roomFolder(root, label, roomId) {
  if (!String(root ?? '').trim()) throw new Error('Configure a Rooms folder first.');
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(String(roomId ?? ''))) throw new Error('Invalid room identifier.');
  return inside(root, path.join(path.resolve(root), `${safeName(label)}_${roomId.slice(0, 8)}`));
}

function normalizeRoomStatus(raw, room) {
  if (!raw || typeof raw !== 'object') throw new Error('The room service returned invalid data.');
  const players = Array.isArray(raw.players) ? raw.players : [];
  const downloads = new Map((Array.isArray(raw.downloads) ? raw.downloads : []).map((item) => [Number(item?.slot), String(item?.download ?? '')]));
  const slots = players.map((entry, index) => {
    const tuple = Array.isArray(entry) ? entry : [];
    const hasNumber = Number.isInteger(Number(tuple[0])) && tuple.length >= 3;
    const slot = hasNumber ? Number(tuple[0]) : index + 1;
    return { slot, name: String(tuple[hasNumber ? 1 : 0] ?? `Slot ${slot}`), game: String(tuple[hasNumber ? 2 : 1] ?? 'Unknown'), downloadAvailable: downloads.has(slot) };
  });
  const port = Number(raw.last_port);
  return {
    roomId: room.id,
    url: room.url,
    trackerId: typeof raw.tracker === 'string' ? raw.tracker : undefined,
    lastPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined,
    lastActivity: raw.last_activity ? String(raw.last_activity) : undefined,
    timeout: Number.isFinite(Number(raw.timeout)) ? Number(raw.timeout) : undefined,
    refreshedAt: new Date().toISOString(),
    stale: false,
    slots,
  };
}

const CLIENT_STATUS = new Map([
  [0, 'Unknown'], [5, 'Connected'], [10, 'Ready'], [20, 'Playing'], [30, 'Finished'],
]);

function indexByPlayer(entries) {
  return new Map((Array.isArray(entries) ? entries : []).map((entry) => [Number(entry?.player), entry]));
}

function invertNames(values) {
  return new Map(Object.entries(values ?? {}).map(([name, id]) => [Number(id), name]));
}

function normalizeTrackerDashboard(dynamic, fixed, slots, packages = {}) {
  if (!dynamic || !fixed) throw new Error('The tracker service returned incomplete data.');
  const slotMap = new Map((Array.isArray(slots) ? slots : []).map((slot) => [Number(slot.slot), slot]));
  for (const entry of Array.isArray(fixed.player_game) ? fixed.player_game : []) {
    const slot = Number(entry.player);
    if (!slotMap.has(slot)) slotMap.set(slot, { slot, name: `Slot ${slot}`, game: String(entry.game ?? 'Unknown') });
  }
  const aliases = indexByPlayer(dynamic.aliases);
  const checks = indexByPlayer(dynamic.player_checks_done);
  const totals = indexByPlayer(fixed.player_locations_total);
  const received = indexByPlayer(dynamic.player_items_received);
  const statuses = indexByPlayer(dynamic.player_status);
  const activity = indexByPlayer(dynamic.activity_timers);
  const connections = indexByPlayer(dynamic.connection_timers);
  const hintRows = Array.isArray(dynamic.hints) ? dynamic.hints : [];
  const uniqueHints = new Map();
  for (const row of hintRows) {
    for (const hint of Array.isArray(row?.hints) ? row.hints : []) {
      if (!Array.isArray(hint) || hint.length < 8) continue;
      uniqueHints.set(JSON.stringify(hint), hint);
    }
  }
  const names = new Map(Object.entries(packages).map(([game, data]) => [game, {
    items: invertNames(data?.item_name_to_id), locations: invertNames(data?.location_name_to_id),
  }]));
  const playerName = (slot) => aliases.get(slot)?.alias || slotMap.get(slot)?.name || `Slot ${slot}`;
  const players = [...slotMap.values()].sort((a, b) => Number(a.slot) - Number(b.slot)).map((slot) => {
    const id = Number(slot.slot);
    const status = Number(statuses.get(id)?.status ?? 0);
    const playerHints = [...uniqueHints.values()].filter((hint) => Number(hint[0]) === id || Number(hint[1]) === id);
    return {
      slot: id, name: String(slot.name ?? `Slot ${id}`), alias: aliases.get(id)?.alias || undefined,
      game: String(slot.game ?? 'Unknown'), checksDone: checks.get(id)?.locations?.length ?? 0,
      checksTotal: Number(totals.get(id)?.total_locations ?? 0), itemsReceived: received.get(id)?.items?.length ?? 0,
      status, statusLabel: CLIENT_STATUS.get(status) ?? `Status ${status}`,
      lastActivity: activity.get(id)?.time || undefined, lastConnection: connections.get(id)?.time || undefined,
      hintCount: playerHints.length, unresolvedHintCount: playerHints.filter((hint) => !hint[4]).length,
    };
  });
  const hints = [...uniqueHints.values()].map((hint) => {
    const receivingSlot = Number(hint[0]);
    const findingSlot = Number(hint[1]);
    const receiverGame = slotMap.get(receivingSlot)?.game;
    const finderGame = slotMap.get(findingSlot)?.game;
    const flags = Number(hint[6] ?? 0);
    const status = Number(hint[7] ?? 0);
    return {
      receivingSlot, receivingName: playerName(receivingSlot), findingSlot, findingName: playerName(findingSlot),
      itemId: Number(hint[3]), item: names.get(receiverGame)?.items.get(Number(hint[3])) ?? `Item ${hint[3]}`,
      locationId: Number(hint[2]), location: names.get(finderGame)?.locations.get(Number(hint[2])) ?? `Location ${hint[2]}`,
      found: Boolean(hint[4]), entrance: String(hint[5] ?? ''), flags, status,
      classification: flags & 4 ? 'Trap' : flags & 1 ? 'Progression' : flags & 2 ? 'Useful' : 'Filler',
      statusLabel: status === 40 || hint[4] ? 'Found' : status === 30 ? 'Priority' : status === 20 ? 'Avoid' : status === 10 ? 'No priority' : 'Unspecified',
    };
  }).sort((a, b) => Number(a.found) - Number(b.found) || b.status - a.status || a.item.localeCompare(b.item));
  const team = (Array.isArray(dynamic.total_checks_done) ? dynamic.total_checks_done : []).find((entry) => Number(entry?.team) === 0);
  return {
    refreshedAt: new Date().toISOString(), players, hints,
    checksDone: Number(team?.checks_done ?? players.reduce((sum, player) => sum + player.checksDone, 0)),
    checksTotal: players.reduce((sum, player) => sum + player.checksTotal, 0),
    completedPlayers: players.filter((player) => player.status === 30).length,
    unresolvedHints: hints.filter((hint) => !hint.found).length,
  };
}

async function fetchJson(net, url) {
  const response = await net.fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Room service returned HTTP ${response.status}.`);
  return response.json();
}

async function refreshRoom(net, rawUrl, wake = false) {
  const room = parseRoomUrl(rawUrl);
  let status = normalizeRoomStatus(await fetchJson(net, `${room.origin}/api/room_status/${room.id}`), room);
  if (wake && !status.lastPort) {
    await net.fetch(room.url, { method: 'GET' });
    for (const delay of [1200, 2500, 5000]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      status = normalizeRoomStatus(await fetchJson(net, `${room.origin}/api/room_status/${room.id}`), room);
      if (status.lastPort) break;
    }
  }
  return status;
}

function contentFileName(response, downloadUrl, slot) {
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = encoded ? decodeURIComponent(encoded) : plain;
  if (!candidate) candidate = path.basename(new URL(downloadUrl).pathname);
  return safeName(candidate, `slot-${slot}.patch`);
}

async function authoritativeDownload(net, roomUrl, slot) {
  const room = parseRoomUrl(roomUrl);
  const raw = await fetchJson(net, `${room.origin}/api/room_status/${room.id}`);
  const item = (Array.isArray(raw.downloads) ? raw.downloads : []).find((entry) => Number(entry?.slot) === Number(slot));
  if (!item?.download) throw new Error('This slot has no downloadable file.');
  const url = new URL(String(item.download), room.origin);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== ROOM_HOST) throw new Error('The room returned an unsafe download address.');
  return url.toString();
}

async function fetchRoomDownload(net, rawUrl) {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== ROOM_HOST) throw new Error('The room download redirected outside archipelago.gg.');
    const response = await net.fetch(url.toString(), { method: 'GET', redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error('The room download returned an invalid redirect.');
    url = new URL(location, url);
  }
  throw new Error('The room download redirected too many times.');
}

async function fileRecord(filePath, kind, sourceFileId) {
  const stats = await fs.stat(filePath);
  return { id: Buffer.from(filePath.toLowerCase()).toString('base64url'), name: path.basename(filePath), path: filePath, kind, size: stats.size, modifiedAt: stats.mtime.toISOString(), sourceFileId };
}

async function listFiles(folder, kind) {
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return []; }
  return Promise.all(entries.filter((entry) => entry.isFile() && !entry.name.endsWith('.part')).map((entry) => fileRecord(path.join(folder, entry.name), kind)));
}

async function ensureRoom(root, label, roomId) {
  const folder = roomFolder(root, label, roomId);
  await fs.mkdir(path.join(folder, 'downloads'), { recursive: true });
  await fs.mkdir(path.join(folder, 'play'), { recursive: true });
  return folder;
}

async function downloadSlot(net, payload) {
  const folder = inside(payload.roomsRoot, payload.folderPath);
  const downloadFolder = inside(folder, path.join(folder, 'downloads', safeName(payload.slotName, `slot-${payload.slot}`)));
  await fs.mkdir(downloadFolder, { recursive: true });
  const downloadUrl = await authoritativeDownload(net, payload.roomUrl, payload.slot);
  const response = await fetchRoomDownload(net, downloadUrl);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error('The slot file is larger than the 512 MB safety limit.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('The slot file is larger than the 512 MB safety limit.');
  const preferred = inside(downloadFolder, path.join(downloadFolder, contentFileName(response, downloadUrl, payload.slot)));
  const parsed = path.parse(preferred);
  let target = preferred;
  let suffix = 2;
  while (await fs.access(target).then(() => true).catch(() => false)) target = path.join(parsed.dir, `${parsed.name}-${suffix++}${parsed.ext}`);
  const temporary = `${target}.${randomUUID()}.part`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  return listFiles(downloadFolder, 'downloaded');
}

async function downloadControllerSlot(net, payload) {
  const room = parseControllerInvite(payload.roomUrl);
  const filesResponse = await net.fetch(`${room.origin}/api/controller/v1/room/${room.id}/slots/${Number(payload.slot)}/files`);
  if (!filesResponse.ok) throw new Error(`Controller room file list returned HTTP ${filesResponse.status}.`);
  const files = await filesResponse.json();
  if (!Array.isArray(files) || !files[0]?.id) throw new Error('This slot has no shared file.');
  const response = await net.fetch(`${room.origin}/api/controller/v1/room/${room.id}/files/${encodeURIComponent(files[0].id)}`);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('The slot file is larger than the 512 MB safety limit.');
  const folder = inside(payload.roomsRoot, payload.folderPath);
  const downloadFolder = inside(folder, path.join(folder, 'downloads', safeName(payload.slotName, `slot-${payload.slot}`)));
  await fs.mkdir(downloadFolder, { recursive: true });
  const target = inside(downloadFolder, path.join(downloadFolder, safeName(files[0].name, `slot-${payload.slot}.patch`)));
  const temporary = `${target}.${randomUUID()}.part`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, target).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  });
  return listFiles(downloadFolder, 'downloaded');
}

async function importFile(sourcePath, payload) {
  const folder = inside(payload.roomsRoot, payload.folderPath);
  const downloadFolder = inside(folder, path.join(folder, 'downloads', safeName(payload.slotName, `slot-${payload.slot}`)));
  await fs.mkdir(downloadFolder, { recursive: true });
  const target = inside(downloadFolder, path.join(downloadFolder, safeName(path.basename(sourcePath), 'imported-file')));
  const finalTarget = await fs.access(target).then(() => {
    const parsed = path.parse(target);
    return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
  }).catch(() => target);
  await fs.copyFile(sourcePath, finalTarget);
  return listFiles(downloadFolder, 'imported');
}

function patchArchive(buffer, endpoint) {
  const entries = unzipSync(new Uint8Array(buffer));
  for (const entryName of Object.keys(entries)) {
    const normalized = entryName.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part.includes(':') || part.includes('\0'))) {
      throw new Error(`Unsafe ZIP entry: ${entryName}`);
    }
  }
  const manifests = Object.keys(entries).filter((name) => name.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() === 'archipelago.json');
  if (manifests.length !== 1) throw new Error(manifests.length ? 'Patch contains multiple archipelago.json manifests.' : 'Patch has no archipelago.json manifest.');
  const manifest = JSON.parse(Buffer.from(entries[manifests[0]]).toString('utf8'));
  manifest.server = endpoint;
  entries[manifests[0]] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  return { bytes: Buffer.from(zipSync(entries, { level: 6 })), manifest };
}

async function prepareFile(payload, endpoint) {
  const folder = inside(payload.roomsRoot, payload.folderPath);
  const source = inside(path.join(folder, 'downloads'), payload.sourcePath);
  const playFolder = inside(folder, path.join(folder, 'play', safeName(payload.slotName, `slot-${payload.slot}`)));
  await fs.mkdir(playFolder, { recursive: true });
  const target = inside(playFolder, path.join(playFolder, path.basename(source)));
  const buffer = await fs.readFile(source);
  let manifest;
  let bytes = buffer;
  let patched = false;
  try {
    const result = patchArchive(buffer, endpoint);
    bytes = result.bytes;
    manifest = result.manifest;
    patched = true;
  } catch (error) {
    if (/^\.ap/i.test(path.extname(source)) && !/no archipelago\.json manifest/i.test(error.message)) throw new Error(`Patch inspection failed: ${error.message}`);
  }
  const temporary = `${target}.${randomUUID()}.part`;
  const backup = `${target}.${randomUUID()}.backup`;
  let backedUp = false;
  try {
    await fs.writeFile(temporary, bytes);
    backedUp = await fs.rename(target, backup).then(() => true).catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    await fs.rename(temporary, target);
    if (backedUp) await fs.rm(backup, { force: true });
  } catch (error) {
    if (backedUp) await fs.rename(backup, target).catch(() => {});
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.rm(backup, { force: true }).catch(() => {});
  }
  const warnings = [];
  if (manifest?.player_name && String(manifest.player_name) !== String(payload.slotName)) warnings.push(`Patch player is ${manifest.player_name}, room slot is ${payload.slotName}.`);
  if (manifest?.game && String(manifest.game).toLocaleLowerCase() !== String(payload.game).toLocaleLowerCase()) warnings.push(`Patch game is ${manifest.game}, room game is ${payload.game}.`);
  return { file: await fileRecord(target, 'prepared', payload.sourceFileId), playFolder, patched, manifest, warnings };
}

function connectionUri(slotName, password, host, port, game) {
  if (game === undefined) { game = port; port = host; host = ROOM_HOST; }
  const user = encodeURIComponent(String(slotName));
  const secret = encodeURIComponent(String(password ?? ''));
  return `archipelago://${user}:${secret}@${host}:${port}?game=${encodeURIComponent(String(game))}`;
}

function opaqueFileId(filePath) {
  return createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('base64url');
}

function protectedArtifact(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.archipelago') || lower.endsWith('.apsave') || lower.includes('spoiler') || lower === 'host.yaml' || lower === 'session.json';
}

function patchCandidate(name) {
  const ext = path.extname(name).toLowerCase();
  return ext.startsWith('.ap') && !['.archipelago', '.apsave', '.apworld'].includes(ext);
}

function manifestFor(buffer) {
  try {
    const entries = unzipSync(new Uint8Array(buffer));
    const key = Object.keys(entries).find((name) => name.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() === 'archipelago.json');
    return key ? JSON.parse(Buffer.from(entries[key]).toString('utf8')) : undefined;
  } catch { return undefined; }
}

function matchingSlot(slots, name, manifest) {
  const player = String(manifest?.player_name ?? manifest?.player ?? manifest?.slot_name ?? '').trim().toLocaleLowerCase();
  if (player) {
    const exact = slots.filter((slot) => slot.name.trim().toLocaleLowerCase() === player);
    if (exact.length === 1) return exact[0];
  }
  const lower = name.toLocaleLowerCase();
  const matches = slots.filter((slot) => lower.includes(slot.name.toLocaleLowerCase()));
  return matches.length === 1 ? matches[0] : undefined;
}

async function adoptLocalRun(payload) {
  const folder = await ensureRoom(payload.roomsRoot, payload.label, payload.roomId);
  const slots = (Array.isArray(payload.slots) ? payload.slots : []).map((slot, index) => ({ slot: Number(slot.slot) || index + 1, name: String(slot.name), game: String(slot.game), mine: true, downloadAvailable: false, files: [] }));
  const sourceRoot = path.resolve(String(payload.sessionPath ?? ''));
  const candidates = [];
  async function walk(root, depth = 0) {
    if (depth > 5) return;
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) await walk(candidate, depth + 1);
      else if (!protectedArtifact(entry.name)) {
        if (patchCandidate(entry.name)) candidates.push({ name: entry.name, path: candidate });
        else if (path.extname(entry.name).toLowerCase() === '.zip') {
          const bytes = await fs.readFile(candidate);
          if (manifestFor(bytes)) candidates.push({ name: entry.name, bytes });
        }
      }
    }
  }
  await walk(sourceRoot);
  if (!candidates.length) {
    let archive = payload.artifactPath;
    if (!archive || !String(archive).toLowerCase().endsWith('.zip')) {
      try { archive = (await fs.readdir(sourceRoot)).map((name) => path.join(sourceRoot, name)).find((name) => name.toLowerCase().endsWith('.zip')); } catch { archive = undefined; }
    }
    if (archive) {
      const entries = unzipSync(new Uint8Array(await fs.readFile(archive)));
      for (const [name, bytes] of Object.entries(entries)) {
        const buffer = Buffer.from(bytes);
        if (!protectedArtifact(name) && (patchCandidate(name) || path.extname(name).toLowerCase() === '.zip' && manifestFor(buffer))) candidates.push({ name: path.basename(name), bytes: buffer });
      }
    }
  }
  const unresolved = [];
  for (const candidate of candidates) {
    const bytes = candidate.bytes ?? await fs.readFile(candidate.path);
    const slot = matchingSlot(slots, candidate.name, manifestFor(bytes));
    if (!slot) { unresolved.push(candidate.name); continue; }
    const destination = inside(folder, path.join(folder, 'downloads', safeName(slot.name, `slot-${slot.slot}`)));
    await fs.mkdir(destination, { recursive: true });
    const target = inside(destination, path.join(destination, safeName(candidate.name, `slot-${slot.slot}.patch`)));
    if (!await fs.access(target).then(() => true).catch(() => false)) await fs.writeFile(target, bytes, { flag: 'wx' });
    slot.downloadAvailable = true;
    slot.files = await listFiles(destination, 'downloaded');
  }
  return { folderPath: folder, slots, unresolved };
}

async function archiveSlotSummary(archivePath) {
  try {
    const entries = unzipSync(new Uint8Array(await fs.readFile(archivePath)));
    const slots = [];
    for (const [name, bytes] of Object.entries(entries)) {
      if (protectedArtifact(name)) continue;
      const manifest = manifestFor(Buffer.from(bytes));
      const player = String(manifest?.player_name ?? manifest?.player ?? manifest?.slot_name ?? '').trim();
      const game = String(manifest?.game ?? '').trim();
      if (player && game && !slots.some((slot) => slot.name.toLocaleLowerCase() === player.toLocaleLowerCase())) slots.push({ name: player, game });
    }
    return { playerCount: new Set(slots.map((slot) => slot.name.split('_')[0].toLocaleLowerCase())).size || slots.length, slotCount: slots.length, games: [...new Set(slots.map((slot) => slot.game))], slots };
  } catch { return { playerCount: 0, slotCount: 0, games: [], slots: [] }; }
}

function trackerUrl(roomUrl, trackerId, slot) {
  const room = parseRoomUrl(roomUrl);
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(String(trackerId ?? ''))) throw new Error('This room has no tracker yet.');
  return slot == null ? `${room.origin}/tracker/${trackerId}` : `${room.origin}/tracker/${trackerId}/0/${Number(slot)}`;
}

function sphereTrackerUrl(roomUrl, trackerId) {
  const room = parseRoomUrl(roomUrl);
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(String(trackerId ?? ''))) throw new Error('This room has no sphere tracker yet.');
  return `${room.origin}/sphere_tracker/${trackerId}`;
}

async function sharedSlotInventory(payload) {
  const folder = inside(payload.roomsRoot, payload.folderPath);
  const shared = new Set((payload.sharedSlots ?? []).map(Number));
  const result = [];
  for (const slot of payload.slots ?? []) {
    let files = [];
    if (shared.has(Number(slot.slot))) {
      const slotFolder = inside(folder, path.join(folder, 'downloads', safeName(slot.name, `slot-${slot.slot}`)));
      files = (await listFiles(slotFolder, 'downloaded')).map((file) => ({ ...file, id: opaqueFileId(file.path) }));
    }
    result.push({ slot: Number(slot.slot), name: String(slot.name), game: String(slot.game), files });
  }
  return result;
}

module.exports = {
  MAX_DOWNLOAD_BYTES, adoptLocalRun, archiveSlotSummary, connectionUri, downloadControllerSlot, downloadSlot, ensureRoom, importFile, inside, listFiles,
  normalizeRoomStatus, normalizeTrackerDashboard, opaqueFileId, parseControllerInvite, parseRoomUrl, patchArchive, prepareFile, refreshControllerRoom, refreshRoom, roomFolder, safeName, sharedSlotInventory, sphereTrackerUrl, trackerUrl,
};
