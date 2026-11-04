const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRoomLiveState } = require('./room-live-state.cjs');
const { roomPage } = require('./room-page.cjs');

const API_PREFIX = '/api/controller/v1/room/';
const API_V2_PREFIX = '/api/controller/v2/room/';
const SCHEMA_VERSION = '2.0.0';
const MAX_REQUESTS_PER_MINUTE = 180;
const MAX_ACTIVE_DOWNLOADS = 3;
const NETWORK_OPERATION_TIMEOUT = 7000;

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function publicJson(request, response, value) {
  const body = Buffer.from(JSON.stringify(value));
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
  const headers = {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'etag': etag,
    'x-content-type-options': 'nosniff',
  };
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers);
    return response.end();
  }
  response.writeHead(200, { ...headers, 'content-length': body.length });
  response.end(body);
}

function remoteFile(file) {
  return {
    id: file.id,
    sourceId: file.id,
    revision: createHash('sha256').update(`${file.id}:${file.size}:${file.modifiedAt || ''}`).digest('hex').slice(0, 24),
    name: file.name,
    size: file.size,
    kind: file.kind,
  };
}

function page(roomId) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Archipelago Room</title><style>
  :root{color-scheme:dark;font-family:Segoe UI,system-ui,sans-serif;background:#111715;color:#e3ebe8;--line:#33423d;--panel:#1b2522;--muted:#91a19b;--green:#57bd96;--gold:#e0ad5c}*{box-sizing:border-box}body{margin:0;min-width:320px;background:#141c19}button,a{font:inherit}button{cursor:pointer}.top{border-bottom:1px solid var(--line);background:#101614}.top-inner,main{width:min(1120px,calc(100% - 32px));margin:auto}.top-inner{min-height:54px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:9px;font-weight:750}.mark{width:28px;height:28px;border:1px solid #3c6457;border-radius:5px;display:grid;place-items:center;color:#87d8b8;background:#1d302a}.provider{color:#7f9089;font-size:11px}.hero{padding:26px 0 20px;display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.eyebrow{color:#75bda2;font-size:10px;font-weight:750;text-transform:uppercase}h1{margin:5px 0 6px;font-size:25px;letter-spacing:0}.meta,.muted,small{color:var(--muted)}.badge{height:25px;padding:0 9px;border-radius:4px;display:inline-flex;align-items:center;color:#a7e5cc;background:#1d493c;font-size:11px;font-weight:750}.badge.offline{color:#c4ccc9;background:#303a37}.connect{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#19231f}.connect-inner{width:min(1120px,calc(100% - 32px));min-height:88px;margin:auto;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px}.connect-label{margin-bottom:6px;color:#9baba5;font-size:10px;font-weight:700;text-transform:uppercase}.command{display:flex;align-items:center;gap:9px}.command code{min-width:0;overflow:hidden;color:#b9e8d6;font:14px Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.button{min-height:34px;padding:0 11px;border:1px solid #456158;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;color:#d7e1dd;background:#24312d;text-decoration:none}.button:hover{border-color:#6b8d81;background:#2b3b35}.button.primary{border-color:#287b62;color:white;background:#278b6c}.password-note{margin-top:6px;color:#d7b574;font-size:10px}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--line)}.stat{min-height:65px;padding:13px 18px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:3px}.stat:last-child{border-right:0}.stat strong{font-size:18px}.stat span{color:var(--muted);font-size:10px}.content{padding:24px 0 38px}.section-heading{margin-bottom:9px;display:flex;align-items:end;justify-content:space-between;gap:14px}.section-heading h2{margin:0;font-size:15px}.section-heading span{color:var(--muted);font-size:10px}.table{border:1px solid var(--line);background:var(--panel)}.row{min-height:57px;padding:8px 12px;border-bottom:1px solid var(--line);display:grid;grid-template-columns:45px minmax(170px,1fr) minmax(170px,1fr) 110px minmax(210px,1.25fr) 110px;align-items:center;gap:10px}.row:last-child{border-bottom:0}.row.head{min-height:34px;color:#7f8f89;background:#17201d;font-size:9px;font-weight:750;text-transform:uppercase}.identity{min-width:0;display:flex;flex-direction:column;gap:3px}.identity strong,.identity small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.presence{display:flex;align-items:center;gap:7px;color:#aab7b2;font-size:10px}.dot{width:7px;height:7px;border-radius:50%;background:#596762}.dot.online{background:var(--green);box-shadow:0 0 0 3px #234438}.downloads{display:flex;flex-direction:column;align-items:flex-start;gap:4px}.download{max-width:100%;padding:0;border:0;color:#95d8be;background:none;text-align:left;text-decoration:none;font-size:10px}.download:hover{text-decoration:underline}.download span{color:#7f918a}.none{color:#778680;font-size:10px}.details{margin-top:20px;border-top:1px solid var(--line);display:grid;grid-template-columns:1fr 1fr}.detail{min-height:42px;padding:10px 12px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:12px;font-size:10px}.detail:nth-child(odd){border-right:1px solid var(--line)}.detail span:first-child{color:var(--muted)}.detail span:last-child{max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}.error{margin:14px 0;color:#ffaaa2;font-size:11px}.footer{padding:15px 0;border-top:1px solid var(--line);color:#71817b;font-size:10px}.loading{padding:24px 12px;color:var(--muted)}@media(max-width:820px){.row{grid-template-columns:36px minmax(130px,1fr) minmax(130px,1fr) 90px minmax(150px,1fr)}.row>*:last-child{display:none}}@media(max-width:620px){.top-inner,main,.connect-inner{width:min(100% - 20px,1120px)}.hero,.connect-inner{align-items:stretch;grid-template-columns:1fr;flex-direction:column}.actions{justify-content:flex-start}.stats{grid-template-columns:1fr 1fr}.stat:nth-child(2){border-right:0}.row.head{display:none}.row{grid-template-columns:32px minmax(0,1fr);gap:5px 9px}.row>*{grid-column:2}.row>*:first-child{grid-column:1;grid-row:1/6}.row>*:last-child{display:block}.details{grid-template-columns:1fr}.detail:nth-child(odd){border-right:0}}</style></head><body><div class="top"><div class="top-inner"><div class="brand"><span class="mark">AP</span><span>Archipelago Controller</span></div><span class="provider">Controller-hosted multiworld</span></div></div><main><header class="hero"><div><span class="eyebrow" id="generation">Multiworld</span><h1 id="name">Controller Room</h1><div class="meta" id="room-meta">Reading room status...</div></div><span class="badge" id="state">Loading</span></header></main><section class="connect"><div class="connect-inner"><div><div class="connect-label">Connect with an Archipelago client</div><div class="command"><code id="command">Waiting for the game server...</code><button class="button" id="copy" type="button">Copy</button></div><div class="password-note" id="password"></div></div><div class="actions"><a class="button primary" id="controller-link" href="#">Open in Controller</a><button class="button" id="refresh" type="button">Refresh status</button></div></div></section><main><section class="stats"><div class="stat"><strong id="player-count">0</strong><span>Shared slots</span></div><div class="stat"><strong id="game-count">0</strong><span>Games</span></div><div class="stat"><strong id="connected-count">0</strong><span>Connected</span></div><div class="stat"><strong id="file-count">0</strong><span>Downloads</span></div></section><section class="content"><div class="section-heading"><h2>Players and files</h2><span id="refreshed">Not refreshed yet</span></div><div class="table" id="slots"><div class="loading">Loading shared slots...</div></div><div class="details"><div class="detail"><span>Hosting</span><span>Archipelago Controller</span></div><div class="detail"><span>Transport</span><span id="transport">Unknown</span></div><div class="detail"><span>Room created</span><span id="created">Unknown</span></div><div class="detail"><span>Server activity</span><span id="activity">Unknown</span></div><div class="detail"><span>Multiworld tracker</span><span id="multi-tracker">Unavailable</span></div><div class="detail"><span>Sphere tracker</span><span id="sphere-tracker">Unavailable</span></div></div><p class="error" id="error"></p></section><footer class="footer">This invitation grants access to the room metadata and the downloads selected by the host. It never includes the room password.</footer></main><script>
  const id=${JSON.stringify(roomId)};
  const byId=(value)=>document.getElementById(value); const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node};
  const date=(value)=>value?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'Unknown';
  const size=(value)=>value<1048576?Math.max(1,Math.round(value/1024))+' KB':(value/1048576).toFixed(1)+' MB';
  async function download(file){const response=await fetch('/api/controller/v1/room/'+encodeURIComponent(id)+'/files/'+encodeURIComponent(file.id));if(!response.ok)throw new Error('Download failed with HTTP '+response.status);const blob=await response.blob();const anchor=document.createElement('a');anchor.href=URL.createObjectURL(blob);anchor.download=file.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(anchor.href),1000)}
  function renderSlots(room){const target=byId('slots');target.textContent='';const head=document.createElement('div');head.className='row head';for(const label of ['Id','Name','Game','Status','Download link','Tracker page'])head.append(text('span',label));target.append(head);for(const slot of room.slots){const row=document.createElement('div');row.className='row';row.append(text('span',String(slot.slot),'muted'));const identity=document.createElement('div');identity.className='identity';identity.append(text('strong',slot.name),text('small','Slot '+slot.slot));row.append(identity,text('span',slot.game));const presence=document.createElement('div');presence.className='presence';presence.append(text('i','',slot.connected?'dot online':'dot'),text('span',slot.connected?'Connected':'Not connected'));row.append(presence);const downloads=document.createElement('div');downloads.className='downloads';if(slot.files.length){for(const file of slot.files){const button=text('button',file.name+' ','download');button.type='button';button.append(text('span','('+size(file.size)+')'));button.onclick=()=>download(file).catch((error)=>byId('error').textContent=error.message);downloads.append(button)}}else downloads.append(text('span','No shared file','none'));row.append(downloads,text('span','Not available','none'));target.append(row)}}
  async function load(){try{byId('error').textContent='';const response=await fetch('/api/controller/v1/room/'+encodeURIComponent(id)+'/status');if(!response.ok)throw new Error(response.status===404?'This room invitation is no longer available.':'Room service returned '+response.status);const room=await response.json();const endpoint=room.endpoint?room.endpoint.host+':'+room.endpoint.port:'';const files=room.slots.flatMap((slot)=>slot.files);const games=new Set(room.slots.map((slot)=>slot.game));byId('name').textContent=room.label;byId('generation').textContent='Multiworld '+(room.generationId?room.generationId.slice(0,8):room.roomId.slice(0,8));byId('room-meta').textContent=room.slots.length+' shared slot'+(room.slots.length===1?'':'s')+' across '+games.size+' game'+(games.size===1?'':'s');byId('state').textContent=room.state;byId('state').className='badge '+(room.state==='Online'?'':'offline');byId('command').textContent=endpoint?'/connect '+endpoint:'Game server is offline';byId('copy').disabled=!endpoint;byId('copy').onclick=()=>navigator.clipboard.writeText('/connect '+endpoint);byId('password').textContent=room.passwordRequired?'A room password is required. Ask the host for it separately.':'No room password is required.';byId('player-count').textContent=room.slots.length;byId('game-count').textContent=games.size;byId('connected-count').textContent=room.slots.filter((slot)=>slot.connected).length;byId('file-count').textContent=files.length;byId('refreshed').textContent='Updated '+date(room.refreshedAt);byId('transport').textContent=room.endpoint?.secure?'Encrypted WebSocket gateway':'Direct game-server connection';byId('created').textContent=date(room.createdAt);byId('activity').textContent=date(room.lastActivityAt||room.startedAt);byId('multi-tracker').textContent=room.trackerCapabilities?.multitracker?'Available':'Not enabled';byId('sphere-tracker').textContent=room.trackerCapabilities?.sphere?'Available':'Not enabled';renderSlots(room)}catch(error){byId('state').textContent='Unavailable';byId('state').className='badge offline';byId('error').textContent=error.message}}
  byId('controller-link').href='archipelago-controller://join?url='+encodeURIComponent(location.href);byId('refresh').onclick=load;load();setInterval(load,30000);
  </script></body></html>`;
}

function localAddress() {
  const candidates = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).filter((address) => address.family === 'IPv4' && !address.internal).map((address) => ({ name, address: address.address })),
  );
  const physical = candidates.find((candidate) => !/virtual|vethernet|wsl|docker|loopback|tunnel|vpn/i.test(candidate.name));
  if (physical) return physical.address;
  if (candidates[0]) return candidates[0].address;
  return '127.0.0.1';
}

async function createMapping(ports) {
  const { upnpNat, pmpNat } = await import('@achingbrain/nat-port-mapper');
  const internalHost = localAddress();
  const options = { protocol: 'tcp', ttl: 3600, description: 'Archipelago Controller' };
  const upnp = upnpNat();
  try {
    for await (const gateway of upnp.findGateways({ signal: AbortSignal.timeout(7000) })) {
      await withTimeout(
        Promise.all(ports.map((port) => gateway.map(port, internalHost, { ...options, externalPort: port }))),
        NETWORK_OPERATION_TIMEOUT,
        'UPnP port mapping timed out.',
      );
      return {
        gateway,
        externalIp: await withTimeout(gateway.externalIp(), NETWORK_OPERATION_TIMEOUT, 'UPnP public-address lookup timed out.'),
        method: 'UPnP',
      };
    }
  } catch { await upnp.stop().catch(() => {}); }
  let gatewayAddress;
  if (process.platform === 'win32') {
    const routes = execFileSync('route.exe', ['print', '-4', '0.0.0.0'], { encoding: 'utf8', windowsHide: true });
    gatewayAddress = routes.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+/m)?.[1];
  } else {
    const { gateway4sync } = await import('default-gateway');
    gatewayAddress = gateway4sync().gateway;
  }
  if (!gatewayAddress) throw new Error('Automatic mapping could not determine the default network gateway.');
  const pmp = pmpNat(gatewayAddress);
  try {
    await withTimeout(
      Promise.all(ports.map((port) => pmp.map(port, internalHost, { ...options, externalPort: port }))),
      NETWORK_OPERATION_TIMEOUT,
      'NAT-PMP port mapping timed out.',
    );
    return {
      gateway: pmp,
      externalIp: await withTimeout(pmp.externalIp(), NETWORK_OPERATION_TIMEOUT, 'NAT-PMP public-address lookup timed out.'),
      method: 'NAT-PMP',
    };
  } catch (error) {
    await pmp.stop().catch(() => {});
    throw error;
  }
}

function createRoomPortal({ patchArchive, onObserved = () => {}, onWake = async () => ({ status: 'disabled' }) }) {
  let server;
  let mapping;
  let config;
  let liveState;
  let trackerSnapshot;
  let sphereSnapshot;
  let logicAnalyses = {};
  let wakeBusy = false;
  let lastWakeAt = 0;
  let activeDownloads = 0;
  const rate = new Map();

  async function stop() {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = undefined;
    if (mapping?.gateway) await mapping.gateway.stop().catch(() => {});
    mapping = undefined;
    config = undefined;
    liveState = undefined;
    trackerSnapshot = undefined;
    sphereSnapshot = undefined;
    logicAnalyses = {};
  }

  async function start(next, onListening) {
    await stop();
    next.startedAt ||= new Date().toISOString();
    next.lastActivityAt ||= next.startedAt;
    config = next;
    liveState = createRoomLiveState(next.slots);
    const files = new Map(next.slots.flatMap((slot) => slot.files.map((file) => [file.id, { ...file, slot: slot.slot }])));
    server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://localhost');
        const ip = request.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const bucket = rate.get(ip) ?? { started: now, count: 0 };
        if (now - bucket.started > 60_000) { bucket.started = now; bucket.count = 0; }
        bucket.count += 1; rate.set(ip, bucket);
        if (bucket.count > MAX_REQUESTS_PER_MINUTE) return json(response, 429, { error: 'Too many requests.' });
        if (request.method === 'GET' && url.pathname === `/room/${next.roomId}`) {
          const body = Buffer.from(roomPage(next.roomId));
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
          return response.end(body);
        }
        if (request.method === 'GET' && url.pathname === '/') {
          response.writeHead(302, { location: `/room/${encodeURIComponent(next.roomId)}`, 'cache-control': 'no-store' });
          return response.end();
        }
        const v2base = `${API_V2_PREFIX}${next.roomId}`;
        const v1base = `${API_PREFIX}${next.roomId}`;
        const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
        const live = liveState.snapshot();
        const tracked = trackerSnapshot;
        const trackedPlayers = new Map((tracked?.players || []).map((player) => [player.slot, player]));
        const trackedNames = new Map((tracked?.players || []).map((player) => [String(player.name || '').trim().toLocaleLowerCase(), player]));
        const slots = next.slots.map((slot) => {
          const player = live.players.find((item) => item.slot === slot.slot);
          const trackedPlayer = trackedNames.get(String(slot.name || '').trim().toLocaleLowerCase()) ?? trackedPlayers.get(slot.slot);
          return {
            slot: slot.slot, name: slot.name, game: slot.game, connected: Boolean(player?.connected),
            checksSeen: trackedPlayer?.checksDone ?? player?.checksSeen ?? 0,
            checksTotal: trackedPlayer?.checksTotal ?? 0,
            itemsSeen: trackedPlayer?.itemsReceived ?? player?.itemsSeen ?? 0,
            status: trackedPlayer?.statusLabel ?? player?.status ?? 'Not connected',
            lastActivityAt: trackedPlayer?.lastActivity ?? player?.lastActivityAt,
            files: slot.files.map(remoteFile),
          };
        });
        const capabilities = {
          apiVersion: 2, progress: true, hints: true, activity: true,
          spheres: Boolean(sphereSnapshot?.available), multipleFiles: true,
          browserTrackers: true, logicAnalysis: true, remoteWake: Boolean(next.allowRemoteWake),
        };
        const hints = tracked?.hints?.map((hint) => ({
          ...hint, timestamp: tracked.refreshedAt, type: hint.found ? 'Found' : 'Open',
          message: `${hint.item} for ${hint.receivingName} at ${hint.location} (${hint.findingName})`,
        })) ?? live.hints;
        const snapshotTime = tracked?.refreshedAt || next.lastActivityAt || next.startedAt;
        const dashboard = tracked ?? {
          refreshedAt: snapshotTime, players: slots.map((slot) => ({
            slot: slot.slot, name: slot.name, game: slot.game, checksDone: slot.checksSeen,
            checksTotal: slot.checksTotal, itemsReceived: slot.itemsSeen, status: slot.connected ? 5 : 0,
            statusLabel: slot.status, lastActivity: slot.lastActivityAt, hintCount: 0, unresolvedHintCount: 0,
          })), hints, checksDone: slots.reduce((sum, slot) => sum + slot.checksSeen, 0),
          checksTotal: slots.reduce((sum, slot) => sum + slot.checksTotal, 0), completedPlayers: live.completedPlayers,
          unresolvedHints: hints.filter((hint) => !hint.found).length,
        };
        const revisionInput = JSON.stringify({ endpoint: next.endpoint, slots, dashboard, events: live.events, sphereSnapshot, logicAnalyses });
        const snapshot = {
          apiVersion: 2, schemaVersion: SCHEMA_VERSION, roomId: next.roomId, label: next.label,
          generationId: next.generationId || undefined, refreshedAt: snapshotTime, stale: false,
          original: {
            lifecycle: next.serverRunning ? 'Online' : 'Offline', endpoint: next.endpoint, passwordRequired: Boolean(next.passwordRequired),
            slots: slots.map(({ slot, name, game, connected, files: remoteFiles }) => ({ slot, name, game, connected, files: remoteFiles })),
            observedAt: snapshotTime, sourceRevision: createHash('sha256').update(revisionInput).digest('hex'),
          },
          enriched: {
            dashboard, hints, activity: live.events,
            spheres: sphereSnapshot ?? { refreshedAt: snapshotTime, available: false, reason: 'absent', checks: [] },
            logic: logicAnalyses, capabilities,
          },
        };
        if (request.method === 'GET' && url.pathname === '/api/controller/v2/schema') return publicJson(request, response, {
          $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Archipelago Controller room snapshot',
          type: 'object', required: ['apiVersion', 'schemaVersion', 'roomId', 'label', 'refreshedAt', 'stale', 'original', 'enriched'],
          properties: {
            apiVersion: { const: 2 }, schemaVersion: { type: 'string' }, roomId: { type: 'string' }, label: { type: 'string' },
            generationId: { type: 'string' }, refreshedAt: { type: 'string', format: 'date-time' }, stale: { type: 'boolean' },
            original: { type: 'object', required: ['lifecycle', 'slots', 'passwordRequired', 'observedAt', 'sourceRevision'] },
            enriched: { type: 'object', required: ['dashboard', 'hints', 'activity', 'spheres', 'logic', 'capabilities'] },
          },
          apiVersion: 2, schemaVersion: SCHEMA_VERSION, compatibleApiVersions: [1, 2], snapshot: `${API_V2_PREFIX}{roomId}/snapshot`,
        });
        if (request.method === 'GET' && url.pathname === `${v2base}/status`) return publicJson(request, response, {
          apiVersion: 2, schemaVersion: SCHEMA_VERSION, roomId: next.roomId, label: next.label,
          generationId: next.generationId, state: snapshot.original.lifecycle, endpoint: next.endpoint,
          passwordRequired: Boolean(next.passwordRequired), refreshedAt: snapshot.refreshedAt, createdAt: next.createdAt,
          startedAt: next.startedAt, lastActivityAt: next.lastActivityAt,
          capabilities, trackerCapabilities: { dashboard: true, liveEvents: true, hints: true, multitracker: true, sphere: capabilities.spheres },
          progress: { checksSeen: dashboard.checksDone, checksTotal: dashboard.checksTotal, itemsSeen: dashboard.players.reduce((sum, player) => sum + player.itemsReceived, 0), completedPlayers: dashboard.completedPlayers, unresolvedHints: dashboard.unresolvedHints, totalsAvailable: Boolean(tracked) },
          hints, activity: live.events, slots,
          tools: next.tools || {},
          wakeNonce: capabilities.remoteWake ? next.wakeNonce : undefined,
        });
        if (request.method === 'GET' && url.pathname === `${v2base}/snapshot`) return publicJson(request, response, snapshot);
        if (request.method === 'GET' && url.pathname === `${v2base}/dashboard`) return publicJson(request, response, dashboard);
        if (request.method === 'GET' && url.pathname === `${v2base}/spheres`) return publicJson(request, response, snapshot.enriched.spheres);
        if (request.method === 'GET' && url.pathname === `${v2base}/trackers`) return publicJson(request, response, { dashboard: `/room/${next.roomId}`, multitracker: `/room/${next.roomId}`, spheres: capabilities.spheres ? `/room/${next.roomId}#spheres` : null });
        const v2SlotMatch = url.pathname.match(new RegExp(`^${v2base}/slots/(\\d+)/files$`));
        if (request.method === 'GET' && v2SlotMatch) {
          const slot = slots.find((item) => item.slot === Number(v2SlotMatch[1]));
          return slot ? publicJson(request, response, slot.files) : json(response, 404, { error: 'Slot not found.' });
        }
        if (request.method === 'POST' && url.pathname === `${v2base}/actions/wake`) {
          if (request.headers['content-type']?.split(';')[0] !== 'application/json') return json(response, 415, { error: 'Wake requires JSON.' });
          if (!next.allowRemoteWake) return json(response, 403, { status: 'disabled' });
          if (!next.wakeNonce || request.headers['x-controller-wake'] !== next.wakeNonce) return json(response, 403, { error: 'Wake nonce rejected.' });
          const origin = String(request.headers.origin || '');
          if (origin && origin !== String(next.publicOrigin || origin)) return json(response, 403, { error: 'Origin rejected.' });
          if (wakeBusy) return json(response, 409, { status: 'busy' });
          if (Date.now() - lastWakeAt < 30_000) return json(response, 429, { status: 'busy', error: 'Wake is cooling down.' });
          wakeBusy = true; lastWakeAt = Date.now();
          try { return json(response, 200, await onWake({ roomId: next.roomId, ip })); }
          finally { wakeBusy = false; }
        }
        const hostExport = url.pathname === `/api/controller/v2/host/room/${next.roomId}/export`;
        if (request.method === 'GET' && hostExport) {
          if (!isLoopback && !next.hostApiRemote) return json(response, 403, { error: 'The host API is loopback-only.' });
          const supplied = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
          const expected = String(next.hostApiKey || '');
          const valid = supplied.length === expected.length && supplied.length > 0 && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
          if (!valid) return json(response, 401, { error: 'Invalid host API key.' });
          const sections = new Set(String(url.searchParams.get('sections') || 'snapshot,source,protocol,tracker,logic,diagnostics').split(',').map((value) => value.trim()));
          if ([...sections].some((section) => !['snapshot', 'source', 'protocol', 'tracker', 'logic', 'diagnostics', 'spoilers'].includes(section))) return json(response, 400, { error: 'Unknown export section.' });
          const includeSpoilers = url.searchParams.get('includeSpoilers') === 'true';
          if (includeSpoilers && next.raceMode) return json(response, 403, { error: 'Spoiler export is unavailable for race-mode seeds.' });
          if (includeSpoilers && !next.allowSpoilerApi) return json(response, 403, { error: 'Spoiler export is disabled in host settings.' });
          const exported = {
            ...(sections.has('snapshot') ? { snapshot } : {}),
            ...(sections.has('source') ? { source: next.sourceMetadata || null } : {}),
            ...(sections.has('protocol') ? { protocol: { observedAt: snapshotTime, endpoint: next.endpoint, connectedSlots: dashboard.players.filter((player) => /connected|playing|goal|finished/i.test(String(player.statusLabel || player.status || ''))).map((player) => player.slot), sourceRevision: snapshot.original.sourceRevision } } : {}),
            ...(sections.has('tracker') ? { tracker: { dashboard, hints, activity: live.events, spheres: snapshot.enriched.spheres } } : {}),
            ...(sections.has('logic') ? { logic: logicAnalyses } : {}),
            ...(sections.has('spoilers') && includeSpoilers ? { spoilers: next.spoilerExport || { available: false, reason: 'absent', checks: [] } } : {}),
            ...(sections.has('diagnostics') ? { diagnostics: { trackerRunning: Boolean(tracked), sphereAvailable: Boolean(sphereSnapshot?.available), spoilersIncluded: Boolean(includeSpoilers && next.allowSpoilerApi && next.raceMode === false) } } : {}),
          };
          if (Buffer.byteLength(JSON.stringify(exported)) > 32 * 1024 * 1024) return json(response, 413, { error: 'Requested export exceeds the 32 MB response limit. Select fewer sections.' });
          return json(response, 200, exported);
        }
        const v2FileMatch = url.pathname.match(new RegExp(`^${v2base}/files/([A-Za-z0-9_-]{10,200})$`));
        if (request.method === 'GET' && v2FileMatch) url.pathname = `${v1base}/files/${v2FileMatch[1]}`;
        if (!url.pathname.startsWith(v1base)) return json(response, 404, { error: 'Not found.' });
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) onObserved(ip);
        const base = v1base;
        if (request.method === 'GET' && url.pathname === `${base}/status`) {
          return json(response, 200, {
          apiVersion: 1, roomId: next.roomId, label: next.label, generationId: next.generationId,
          provider: 'controller', createdAt: next.createdAt || null, startedAt: next.startedAt,
          lastActivityAt: next.lastActivityAt, passwordRequired: Boolean(next.passwordRequired),
          state: next.serverRunning ? 'Online' : 'Offline', endpoint: next.endpoint,
          refreshedAt: new Date().toISOString(), trackerCapabilities: { dashboard: true, liveEvents: true, hints: true, multitracker: Boolean(tracked), sphere: false },
          progress: tracked ? { checksSeen: tracked.checksDone, checksTotal: tracked.checksTotal, itemsSeen: tracked.players.reduce((sum, player) => sum + player.itemsReceived, 0), completedPlayers: tracked.completedPlayers, unresolvedHints: tracked.unresolvedHints, totalsAvailable: true }
            : { checksSeen: live.checksSeen, itemsSeen: live.itemsSeen, completedPlayers: live.completedPlayers, unresolvedHints: live.unresolvedHints, totalsAvailable: false },
          hints, activity: live.events,
          slots: next.slots.map((slot) => {
            const player = live.players.find((item) => item.slot === slot.slot);
            const trackedPlayer = trackedNames.get(String(slot.name || '').trim().toLocaleLowerCase()) ?? trackedPlayers.get(slot.slot);
            return { slot: slot.slot, name: slot.name, game: slot.game, connected: Boolean(player?.connected), checksSeen: trackedPlayer?.checksDone ?? player?.checksSeen ?? 0, checksTotal: trackedPlayer?.checksTotal, itemsSeen: trackedPlayer?.itemsReceived ?? player?.itemsSeen ?? 0, status: trackedPlayer?.statusLabel ?? player?.status ?? 'Not connected', lastActivityAt: trackedPlayer?.lastActivity ?? player?.lastActivityAt, files: slot.files.map(({ id, name, size, kind }) => ({ id, name, size, kind })) };
          }),
        });
        }
        if (request.method === 'GET' && url.pathname === `${base}/slots`) return json(response, 200, next.slots.map((slot) => ({ slot: slot.slot, name: slot.name, game: slot.game, fileCount: slot.files.length })));
        const slotMatch = url.pathname.match(new RegExp(`^${base}/slots/(\\d+)/files$`));
        if (request.method === 'GET' && slotMatch) {
          const slot = next.slots.find((item) => item.slot === Number(slotMatch[1]));
          return slot ? json(response, 200, slot.files.map(({ id, name, size, kind }) => ({ id, name, size, kind }))) : json(response, 404, { error: 'Slot not found.' });
        }
        if (request.method === 'GET' && url.pathname === `${base}/trackers`) return json(response, 200, { dashboard: `/room/${next.roomId}`, multitracker: trackerSnapshot ? `/room/${next.roomId}` : null, sphere: null });
        const fileMatch = url.pathname.match(new RegExp(`^${base}/files/([A-Za-z0-9_-]{10,200})$`));
        if (request.method === 'GET' && fileMatch) {
          if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) return json(response, 503, { error: 'Too many active downloads.' });
          const file = files.get(fileMatch[1]);
          if (!file) return json(response, 404, { error: 'File not found.' });
          activeDownloads += 1;
          try {
            let bytes = await fs.readFile(file.path);
            try { bytes = patchArchive(bytes, `${next.endpoint.host}:${next.endpoint.port}`).bytes; } catch { /* Non-container files remain byte-identical. */ }
            const safe = path.basename(file.name).replace(/[\r\n"]/g, '_');
            response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'content-disposition': `attachment; filename="${safe}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
            return response.end(bytes);
          } finally { activeDownloads -= 1; }
        }
        return json(response, 404, { error: 'Not found.' });
      } catch (error) { return json(response, 500, { error: error.message }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(next.portalPort, next.bindHost || '0.0.0.0', resolve); });
    const boundPort = server.address().port;
    if (onListening) await onListening({ portalPort: boundPort });
    let mappingError;
    if (next.automaticPortMapping) {
      const mappingPorts = next.mappingPorts?.length ? next.mappingPorts : [next.portalPort, next.endpoint.port];
      try { mapping = await createMapping([...new Set(mappingPorts)]); }
      catch (error) { mappingError = error.message; }
    }
    return { portalPort: boundPort, mapping: mapping ? 'mapped' : next.automaticPortMapping ? 'failed' : 'disabled', mappingMethod: mapping?.method, externalIp: mapping?.externalIp, mappingError };
  }

  function updatePresence(text) {
    if (!config) return;
    const line = String(text ?? '');
    if (line.trim()) config.lastActivityAt = new Date().toISOString();
    liveState?.update(line);
  }

  function updateTracker(snapshot) {
    if (snapshot && config && snapshot.roomId !== config.roomId) return;
    trackerSnapshot = snapshot;
    if (snapshot && config) {
      const byName = new Map((snapshot.players || []).map((player) => [String(player.name || '').trim().toLocaleLowerCase(), player]));
      for (const slot of config.slots) {
        const player = byName.get(String(slot.name || '').trim().toLocaleLowerCase());
        if (player && Number.isInteger(Number(player.slot))) slot.slot = Number(player.slot);
      }
    }
  }

  function updateSpheres(snapshot) { sphereSnapshot = snapshot; }
  function updateLogic(slot, analysis) {
    if (!Number.isInteger(Number(slot))) return;
    logicAnalyses = { ...logicAnalyses, [String(slot)]: analysis };
  }

  return { start, stop, updatePresence, updateTracker, updateSpheres, updateLogic, get running() { return Boolean(server?.listening); } };
}

module.exports = { API_PREFIX, API_V2_PREFIX, SCHEMA_VERSION, createRoomPortal, localAddress, withTimeout };
