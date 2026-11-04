const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const API_ROOT = '/api/controller/v2';
const SCHEMA_VERSION = '2.1.0';
const DEFAULT_PORT = 38283;
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function now() { return new Date().toISOString(); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function errorBody(code, message, retryable = false) { return { error: { code, message, retryable } }; }
function safeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function exactOrigins(values) {
  const result = [];
  for (const raw of Array.isArray(values) ? values : []) {
    try {
      const value = String(raw).trim();
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || value.replace(/\/$/, '') !== parsed.origin) continue;
      result.push(parsed.origin);
    } catch { /* Invalid origins are ignored rather than broadening CORS. */ }
  }
  return [...new Set(result)];
}

function remoteFile(file) {
  return {
    id: String(file?.id || file?.sourceId || ''), sourceId: String(file?.sourceId || file?.id || ''),
    revision: String(file?.revision || file?.sourceId || file?.id || ''), name: String(file?.name || 'Room file'),
    size: Math.max(0, Number(file?.size) || 0), kind: String(file?.kind || 'downloaded'),
  };
}

function sanitizeRoom(room) {
  const provider = room?.provider?.type === 'local'
    ? { type: 'local', historyRunId: String(room.provider.historyRunId || '') }
    : { type: room?.provider?.type === 'controller' ? 'controller' : 'official', roomUrl: String(room?.provider?.roomUrl || room?.url || '') };
  return {
    id: String(room?.id || ''), label: String(room?.label || room?.id || 'Room'), url: String(room?.url || ''),
    createdAt: String(room?.createdAt || now()), apiVisible: room?.apiVisible !== false,
    passwordRequired: Boolean(room?.passwordRequired), provider,
    hosted: room?.hosted ? {
      gamePort: safeInteger(room.hosted.gamePort, 38281), allowRemoteWake: Boolean(room.hosted.allowRemoteWake),
      sharedSlots: Array.isArray(room.hosted.sharedSlots) ? room.hosted.sharedSlots.map(Number).filter(Number.isInteger) : [],
    } : undefined,
    slots: (Array.isArray(room?.slots) ? room.slots : []).map((slot) => ({
      slot: Number(slot.slot), name: String(slot.name || `Slot ${slot.slot}`), game: String(slot.game || 'Unknown'), mine: Boolean(slot.mine),
      remoteFiles: (Array.isArray(slot.remoteFiles) ? slot.remoteFiles : []).map(remoteFile),
      files: (Array.isArray(slot.files) ? slot.files : []).map(remoteFile),
    })).filter((slot) => Number.isInteger(slot.slot) && slot.slot > 0),
    logicAnalyses: room?.logicAnalyses && typeof room.logicAnalyses === 'object' ? room.logicAnalyses : {},
  };
}

function trackerLinks(room, record) {
  const capabilities = record?.snapshot?.enriched?.capabilities;
  if (room.provider.type === 'official') {
    const trackerId = String(record?.status?.trackerId || '');
    try {
      const source = new URL(room.provider.roomUrl || room.url);
      if (source.protocol === 'https:' && source.hostname.toLowerCase() === 'archipelago.gg' && /^[A-Za-z0-9_-]{6,100}$/.test(trackerId)) return {
        provider: 'official', multiworld: `${source.origin}/tracker/${trackerId}`,
        spheres: `${source.origin}/sphere_tracker/${trackerId}`, machineReadableSpheres: Boolean(capabilities?.spheres),
      };
    } catch { /* Invalid saved URLs do not become external links. */ }
  }
  if (room.provider.type === 'controller' && room.provider.roomUrl) return {
    provider: 'controller', multiworld: `${room.provider.roomUrl}#progress`,
    spheres: capabilities?.spheres ? `${room.provider.roomUrl}#spheres` : null,
    machineReadableSpheres: Boolean(capabilities?.spheres),
  };
  return { provider: room.provider.type, multiworld: null, spheres: null, machineReadableSpheres: Boolean(capabilities?.spheres) };
}

function openApi(port = DEFAULT_PORT) {
  return `openapi: 3.1.0
info:
  title: Archipelago Controller Room Broker API
  version: ${SCHEMA_VERSION}
servers:
  - url: http://127.0.0.1:${port}/api/controller/v2
paths:
  /health:
    get: { summary: Read broker health, responses: { '200': { description: Broker status } } }
  /rooms:
    get: { summary: List saved rooms, responses: { '200': { description: Room summaries } } }
  /rooms/{roomId}:
    get:
      summary: Read a room summary
      parameters: [ { name: roomId, in: path, required: true, schema: { type: string } } ]
      responses: { '200': { description: Room summary }, '404': { description: Room not found } }
  /rooms/{roomId}/snapshot:
    get:
      summary: Read a normalized room snapshot
      parameters: [ { name: roomId, in: path, required: true, schema: { type: string } } ]
      responses: { '200': { description: Normalized snapshot }, '503': { description: No usable snapshot } }
  /rooms/{roomId}/dashboard:
    get:
      summary: Read normalized player progress
      parameters: [ { $ref: '#/components/parameters/roomId' } ]
      responses: { '200': { description: Tracker dashboard } }
  /rooms/{roomId}/hints:
    get:
      summary: Read normalized hints
      parameters: [ { $ref: '#/components/parameters/roomId' } ]
      responses: { '200': { description: Hint list } }
  /rooms/{roomId}/activity:
    get:
      summary: Read normalized activity
      parameters: [ { $ref: '#/components/parameters/roomId' } ]
      responses: { '200': { description: Activity list } }
  /rooms/{roomId}/spheres:
    get:
      summary: Read checked sphere data
      parameters: [ { $ref: '#/components/parameters/roomId' } ]
      responses: { '200': { description: Sphere snapshot } }
  /rooms/{roomId}/trackers:
    get:
      summary: Read provider browser tracker links
      parameters: [ { $ref: '#/components/parameters/roomId' } ]
      responses: { '200': { description: Multiworld and sphere tracker links } }
  /rooms/{roomId}/actions/refresh:
    post:
      summary: Force a provider refresh
      security: [ { bearerAuth: [] } ]
      parameters: [ { $ref: '#/components/parameters/roomId' } ]
      responses: { '200': { description: Refreshed snapshot } }
  /rooms/{roomId}/actions/wake:
    post:
      summary: Wake an inactive room
      security: [ { bearerAuth: [] } ]
      parameters: [ { $ref: '#/components/parameters/roomId' } ]
      responses: { '200': { description: Wake result } }
components:
  parameters:
    roomId: { name: roomId, in: path, required: true, schema: { type: string } }
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
`;
}

function createRoomBroker({ app, resolveRoom, wakeRoom, getSecret }) {
  const rooms = new Map();
  const records = new Map();
  const inflight = new Map();
  let server;
  let settings = { enabled: true, port: DEFAULT_PORT, remoteEnabled: false, allowedOrigins: [], secretRef: 'room-host-api-key' };
  let state = { running: false, address: '127.0.0.1', port: DEFAULT_PORT, error: '' };
  let loaded = false;

  const cachePath = () => path.join(app.getPath('userData'), 'room-broker-cache.json');

  async function persist() {
    const payload = { version: 1, settings, rooms: [...rooms.values()], records: Object.fromEntries(records) };
    await fs.mkdir(path.dirname(cachePath()), { recursive: true });
    const staged = `${cachePath()}.tmp`;
    await fs.writeFile(staged, JSON.stringify(payload), 'utf8');
    await fs.rename(staged, cachePath());
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const cached = JSON.parse(await fs.readFile(cachePath(), 'utf8'));
      settings = { ...settings, ...(cached.settings || {}), allowedOrigins: Array.isArray(cached.settings?.allowedOrigins) ? cached.settings.allowedOrigins : [] };
      for (const room of cached.rooms || []) if (room?.id) rooms.set(room.id, sanitizeRoom(room));
      for (const [id, record] of Object.entries(cached.records || {})) if (record?.snapshot) records.set(id, { ...record, snapshot: { ...record.snapshot, stale: true } });
    } catch { /* First run or an unreadable old cache. */ }
  }

  function isFresh(record) {
    if (!record?.snapshot?.refreshedAt) return false;
    if (record.snapshot.stale) return false;
    const online = Boolean(record.snapshot.original?.endpoint);
    return Date.now() - Date.parse(record.snapshot.refreshedAt) < (online ? 5_000 : 15_000);
  }

  function staleRecord(record, message) {
    if (!record?.snapshot) return undefined;
    return { ...record, error: message, snapshot: { ...record.snapshot, stale: true, error: message } };
  }

  async function refresh(roomId, options = {}) {
    const room = rooms.get(String(roomId));
    if (!room || !room.apiVisible && !options.internal) throw Object.assign(new Error('That saved room is not exposed through the Room API.'), { code: 'ROOM_NOT_FOUND', status: 404 });
    const current = records.get(room.id);
    if (!options.force && !options.wake && isFresh(current)) return current;
    if (inflight.has(room.id)) return inflight.get(room.id);
    const job = Promise.race([
      Promise.resolve(resolveRoom(room, options)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Room provider refresh timed out.')), 10_000)),
    ]).then((resolved) => {
      if (!resolved?.snapshot) throw new Error('Room provider returned no snapshot.');
      const status = { ...(resolved.status || {}) };
      delete status.snapshot;
      const record = { refreshedAt: now(), status, snapshot: { ...resolved.snapshot, stale: false, error: undefined } };
      records.set(room.id, record);
      void persist().catch(() => {});
      return record;
    }).catch((error) => {
      const stale = staleRecord(records.get(room.id), error.message || String(error));
      if (stale) { records.set(room.id, stale); return stale; }
      throw Object.assign(error, { code: error.code || 'PROVIDER_UNAVAILABLE', status: error.status || 503 });
    }).finally(() => inflight.delete(room.id));
    inflight.set(room.id, job);
    return job;
  }

  function summary(room, record = records.get(room.id)) {
    const snapshot = record?.snapshot;
    const dashboard = snapshot?.enriched?.dashboard;
    return {
      id: room.id, label: room.label, provider: room.provider.type,
      lifecycle: snapshot?.original?.lifecycle || 'Unknown', online: Boolean(snapshot?.original?.endpoint), stale: snapshot?.stale ?? true,
      endpoint: snapshot?.original?.endpoint, refreshedAt: snapshot?.refreshedAt || record?.refreshedAt,
      slots: snapshot?.original?.slots?.length ?? room.slots.length,
      checksDone: dashboard?.checksDone ?? 0, checksTotal: dashboard?.checksTotal ?? 0,
      completedPlayers: dashboard?.completedPlayers ?? 0, unresolvedHints: dashboard?.unresolvedHints ?? 0,
      capabilities: snapshot?.enriched?.capabilities || room.provider.capabilities || { apiVersion: 2, progress: false, hints: false, activity: false, spheres: false, multipleFiles: false, browserTrackers: false, logicAnalysis: false, remoteWake: false },
      trackers: trackerLinks(room, record),
      error: record?.error,
    };
  }

  function isLoopback(request) { return LOOPBACKS.has(String(request.socket.remoteAddress || '').toLowerCase()); }
  async function authorized(request, action = false) {
    if (!action && isLoopback(request)) return true;
    const expected = await getSecret(settings.secretRef).catch(() => '');
    const supplied = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
    if (!expected || !supplied) return false;
    const left = Buffer.from(expected); const right = Buffer.from(supplied);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  function headers(request, extra = {}) {
    const origin = String(request.headers.origin || '');
    const cors = origin && settings.allowedOrigins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
    return { 'cache-control': 'no-store', ...cors, ...extra };
  }

  function send(request, response, statusCode, value, extra = {}) {
    const body = Buffer.from(JSON.stringify(value));
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    if (request.headers['if-none-match'] === etag && statusCode === 200) { response.writeHead(304, headers(request, { etag })); return response.end(); }
    response.writeHead(statusCode, headers(request, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, etag, ...extra }));
    response.end(body);
  }

  async function handler(request, response) {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      const method = String(request.method || 'GET').toUpperCase();
      const origin = String(request.headers.origin || '');
      if (origin && !settings.allowedOrigins.includes(origin)) return send(request, response, 403, errorBody('ORIGIN_REJECTED', 'This browser origin is not allowed.'));
      if (!isLoopback(request) && !settings.remoteEnabled) return send(request, response, 403, errorBody('REMOTE_DISABLED', 'Remote Room API access is disabled.'));
      if (method === 'OPTIONS') {
        response.writeHead(204, headers(request, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' }));
        return response.end();
      }
      if (!await authorized(request, method !== 'GET')) return send(request, response, 401, errorBody('UNAUTHORIZED', 'A valid Room API bearer key is required.'), { 'www-authenticate': 'Bearer' });
      if (method === 'GET' && url.pathname === `${API_ROOT}/health`) return send(request, response, 200, { apiVersion: 2, schemaVersion: SCHEMA_VERSION, state, rooms: [...rooms.values()].filter((room) => room.apiVisible).length, timestamp: now() });
      if (method === 'GET' && url.pathname === `${API_ROOT}/schema`) return send(request, response, 200, { apiVersion: 2, schemaVersion: SCHEMA_VERSION, snapshot: `${API_ROOT}/rooms/{managedRoomId}/snapshot`, openapi: `${API_ROOT}/openapi.yaml` });
      if (method === 'GET' && url.pathname === `${API_ROOT}/openapi.yaml`) {
        const body = Buffer.from(openApi(settings.port));
        response.writeHead(200, headers(request, { 'content-type': 'application/yaml; charset=utf-8', 'content-length': body.length })); return response.end(body);
      }
      if (method === 'GET' && url.pathname === `${API_ROOT}/rooms`) {
        const visible = [...rooms.values()].filter((room) => room.apiVisible);
        for (const room of visible) if (!isFresh(records.get(room.id))) void refresh(room.id).catch(() => {});
        return send(request, response, 200, { apiVersion: 2, rooms: visible.map((room) => summary(room)), refreshedAt: now() });
      }
      const match = url.pathname.match(/^\/api\/controller\/v2\/rooms\/([^/]+)(?:\/(snapshot|dashboard|hints|activity|spheres|trackers))?$/);
      if (method === 'GET' && match) {
        const id = decodeURIComponent(match[1]);
        const room = rooms.get(id);
        if (!room || !room.apiVisible) return send(request, response, 404, errorBody('ROOM_NOT_FOUND', 'That saved room is not exposed through the Room API.'));
        if (!match[2]) {
          await refresh(id);
          return send(request, response, 200, summary(room));
        }
        const record = await refresh(id);
        const snapshot = record.snapshot;
        const value = match[2] === 'snapshot' ? snapshot : match[2] === 'dashboard' ? snapshot.enriched.dashboard : match[2] === 'hints' ? snapshot.enriched.hints : match[2] === 'activity' ? snapshot.enriched.activity : match[2] === 'trackers' ? trackerLinks(room, record) : snapshot.enriched.spheres;
        return send(request, response, 200, value);
      }
      const action = url.pathname.match(/^\/api\/controller\/v2\/rooms\/([^/]+)\/actions\/(refresh|wake)$/);
      if (method === 'POST' && action) {
        const id = decodeURIComponent(action[1]);
        if (!rooms.has(id) || rooms.get(id).apiVisible === false) return send(request, response, 404, errorBody('ROOM_NOT_FOUND', 'That saved room is not exposed through the Room API.'));
        if (action[2] === 'wake') {
          const result = await wakeRoom(rooms.get(id));
          return send(request, response, 200, result);
        }
        const record = await refresh(id, { force: true });
        return send(request, response, 200, record.snapshot);
      }
      return send(request, response, 404, errorBody('NOT_FOUND', 'Room API route not found.'));
    } catch (error) {
      return send(request, response, error.status || 500, errorBody(error.code || 'INTERNAL_ERROR', error.message || 'Room API request failed.', (error.status || 500) >= 500));
    }
  }

  async function stop() {
    if (!server) { state = { ...state, running: false }; return; }
    const closing = server; server = undefined;
    await new Promise((resolve) => closing.close(resolve));
    state = { ...state, running: false };
  }

  async function start() {
    await load();
    await stop();
    state = { running: false, address: settings.remoteEnabled ? '0.0.0.0' : '127.0.0.1', port: settings.port, error: '' };
    if (!settings.enabled) return state;
    server = http.createServer((request, response) => void handler(request, response));
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(settings.port, state.address, resolve); });
      server.removeAllListeners('error');
      server.on('error', () => {});
      state = { ...state, running: true };
    } catch (error) {
      server = undefined;
      state = { ...state, error: error.code === 'EADDRINUSE' ? `Port ${settings.port} is already in use.` : error.message };
    }
    return state;
  }

  async function sync(payload = {}) {
    await load();
    const nextSettings = {
      enabled: payload.settings?.enabled !== false, port: safeInteger(payload.settings?.port, DEFAULT_PORT),
      remoteEnabled: Boolean(payload.settings?.remoteEnabled),
      allowedOrigins: exactOrigins(payload.settings?.allowedOrigins),
      secretRef: String(payload.settings?.secretRef || 'room-host-api-key'),
    };
    const restart = JSON.stringify(nextSettings) !== JSON.stringify(settings);
    settings = nextSettings;
    rooms.clear();
    for (const raw of payload.rooms || []) {
      const room = sanitizeRoom(raw);
      if (room.id) rooms.set(room.id, room);
    }
    for (const id of [...records.keys()]) if (!rooms.has(id)) records.delete(id);
    await persist();
    if (restart || !server && settings.enabled) await start();
    else if (!settings.enabled && server) await stop();
    return state;
  }

  async function inspect(roomId, options = {}) { return refresh(roomId, { ...options, internal: true }); }
  return { load, start, stop, sync, inspect, get state() { return { ...state }; }, openApi: () => openApi(settings.port) };
}

module.exports = { API_ROOT, DEFAULT_PORT, SCHEMA_VERSION, createRoomBroker, openApi, sanitizeRoom };
