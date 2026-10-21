const STATUS_LABELS = new Map([
  [0, 'Unknown'], [5, 'Connected'], [10, 'Ready'], [20, 'Playing'], [30, 'Finished'],
]);

function numberList(value) {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function invertNames(value) {
  const result = new Map();
  for (const [name, id] of Object.entries(value || {})) result.set(Number(id), name);
  return result;
}

function hintObject(raw) {
  if (Array.isArray(raw)) return {
    receivingSlot: Number(raw[0]), findingSlot: Number(raw[1]), locationId: Number(raw[2]),
    itemId: Number(raw[3]), found: Boolean(raw[4]), entrance: String(raw[5] || ''),
    flags: Number(raw[6] || 0), status: Number(raw[7] || 0),
  };
  return {
    receivingSlot: Number(raw?.receiving_player ?? raw?.receivingSlot),
    findingSlot: Number(raw?.finding_player ?? raw?.findingSlot),
    locationId: Number(raw?.location ?? raw?.locationId), itemId: Number(raw?.item ?? raw?.itemId),
    found: Boolean(raw?.found), entrance: String(raw?.entrance || ''),
    flags: Number(raw?.item_flags ?? raw?.flags ?? 0), status: Number(raw?.status ?? 0),
  };
}

function classification(flags) {
  if (flags & 4) return 'Trap';
  if (flags & 1) return 'Progression';
  if (flags & 2) return 'Useful';
  return 'Filler';
}

function createTrackerSidecar({ createSocket, onUpdate = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = () => new Date().toISOString() }) {
  let room;
  let stopped = true;
  let generation = 0;
  const sessions = new Map();
  const packages = new Map();
  const aliases = new Map();

  function emit() { onUpdate(snapshot()); }

  function sessionForSlot(slot) { return [...sessions.values()].find((session) => session.slot === Number(slot)); }

  function slotName(slot) { return aliases.get(slot) || sessionForSlot(slot)?.name || `Slot ${slot}`; }

  function resolveHint(raw) {
    const hint = hintObject(raw);
    if (![hint.receivingSlot, hint.findingSlot, hint.locationId, hint.itemId].every(Number.isFinite)) return null;
    const receivingGame = sessionForSlot(hint.receivingSlot)?.game;
    const findingGame = sessionForSlot(hint.findingSlot)?.game;
    return {
      ...hint,
      receivingName: slotName(hint.receivingSlot), findingName: slotName(hint.findingSlot),
      item: packages.get(receivingGame)?.items.get(hint.itemId) || `Item ${hint.itemId}`,
      location: packages.get(findingGame)?.locations.get(hint.locationId) || `Location ${hint.locationId}`,
      classification: classification(hint.flags),
      statusLabel: hint.status === 40 || hint.found ? 'Found' : hint.status === 30 ? 'Priority' : hint.status === 20 ? 'Avoid' : hint.status === 10 ? 'No priority' : 'Unspecified',
    };
  }

  function player(session) {
    const hints = [...session.hints.values()].map(resolveHint).filter(Boolean);
    return {
      slot: session.slot, name: session.name, alias: aliases.get(session.slot), game: session.game,
      checksDone: session.checked.size, checksTotal: session.locations.size,
      itemsReceived: session.itemsReceived, status: session.status,
      statusLabel: STATUS_LABELS.get(session.status) || `Status ${session.status}`,
      lastActivity: session.lastActivity, lastConnection: session.lastConnection,
      hintCount: hints.length, unresolvedHintCount: hints.filter((hint) => !hint.found).length,
    };
  }

  function snapshot() {
    const players = [...sessions.values()].sort((a, b) => a.slot - b.slot).map(player);
    const hints = new Map();
    for (const session of sessions.values()) for (const raw of session.hints.values()) {
      const hint = resolveHint(raw);
      if (hint) hints.set(`${hint.receivingSlot}:${hint.findingSlot}:${hint.locationId}:${hint.itemId}`, hint);
    }
    return {
      roomId: room?.roomId, running: !stopped, refreshedAt: now(), players, hints: [...hints.values()],
      checksDone: players.reduce((sum, value) => sum + value.checksDone, 0),
      checksTotal: players.reduce((sum, value) => sum + value.checksTotal, 0),
      completedPlayers: players.filter((value) => value.status === 30).length,
      unresolvedHints: [...hints.values()].filter((hint) => !hint.found).length,
    };
  }

  function send(session, packets) {
    if (session.socket?.readyState === 1) session.socket.send(JSON.stringify(packets));
  }

  function requestState(session) {
    const hintKey = `_read_hints_${session.team}_${session.slot}`;
    const statusKey = `_read_client_status_${session.team}_${session.slot}`;
    send(session, [{ cmd: 'SetNotify', keys: [hintKey, statusKey] }, { cmd: 'Get', keys: [hintKey, statusKey] }]);
  }

  function scheduleReconnect(session, token) {
    if (stopped || generation !== token || session.manualClose || session.retryTimer) return;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(session.retry++, 5)));
    session.retryTimer = setTimer(() => { session.retryTimer = null; connect(session, token); }, delay);
  }

  function updateHints(session, value) {
    if (!Array.isArray(value)) return;
    session.hints.clear();
    for (const raw of value) {
      const hint = hintObject(raw);
      if (Number.isFinite(hint.locationId) && Number.isFinite(hint.itemId)) session.hints.set(`${hint.receivingSlot}:${hint.findingSlot}:${hint.locationId}:${hint.itemId}`, raw);
    }
  }

  function handleRetrieved(session, packet) {
    for (const [key, value] of Object.entries(packet.keys || {})) {
      if (key.startsWith('_read_hints_')) updateHints(session, value);
      if (key.startsWith('_read_client_status_') && Number.isFinite(Number(value))) session.status = Number(value);
    }
  }

  function handleDataPackage(packet) {
    for (const [game, data] of Object.entries(packet.data?.games || {})) packages.set(game, {
      items: invertNames(data.item_name_to_id), locations: invertNames(data.location_name_to_id),
    });
  }

  function handlePacket(session, packet) {
    if (packet.cmd === 'RoomInfo') {
      send(session, [{ cmd: 'Connect', password: room.password || null, name: session.name,
        version: { major: 0, minor: 6, build: 8, class: 'Version' },
        tags: ['AP', 'IgnoreGame', 'Tracker', 'NoText'], items_handling: 0b111,
        uuid: `controller-tracker-${room.roomId}-${session.slot}`, game: '', slot_data: false }]);
    } else if (packet.cmd === 'Connected') {
      session.retry = 0;
      session.team = Number(packet.team || 0);
      session.slot = Number(packet.slot || session.slot);
      session.checked = new Set(numberList(packet.checked_locations));
      session.locations = new Set([...session.checked, ...numberList(packet.missing_locations)]);
      session.lastConnection = now(); session.lastActivity = session.lastConnection;
      for (const playerInfo of packet.players || []) {
        const slot = Number(playerInfo.slot);
        if (Number.isFinite(slot)) aliases.set(slot, String(playerInfo.alias || playerInfo.name || slotName(slot)));
      }
      send(session, [{ cmd: 'GetDataPackage', games: [...new Set([...sessions.values()].map((value) => value.game))] }]);
      requestState(session);
    } else if (packet.cmd === 'ReceivedItems') {
      const count = Number(packet.index || 0) + (Array.isArray(packet.items) ? packet.items.length : 0);
      session.itemsReceived = packet.index === 0 ? count : Math.max(session.itemsReceived, count);
      session.lastActivity = now();
    } else if (packet.cmd === 'RoomUpdate') {
      for (const id of numberList(packet.checked_locations)) { session.checked.add(id); session.locations.add(id); }
      if (packet.hint_points !== undefined) session.lastActivity = now();
    } else if (packet.cmd === 'Retrieved') handleRetrieved(session, packet);
    else if (packet.cmd === 'SetReply' && String(packet.key || '').startsWith('_read_')) handleRetrieved(session, { keys: { [packet.key]: packet.value } });
    else if (packet.cmd === 'DataPackage') handleDataPackage(packet);
    else if (packet.cmd === 'ConnectionRefused') session.error = (packet.errors || ['Connection refused']).join(', ');
    emit();
  }

  function connect(session, token) {
    if (stopped || generation !== token) return;
    let socket;
    try { socket = createSocket(`ws://127.0.0.1:${room.port}`); }
    catch { scheduleReconnect(session, token); return; }
    session.socket = socket;
    socket.addEventListener('message', (event) => {
      if (stopped || generation !== token || session.socket !== socket) return;
      try {
        const packets = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        for (const packet of Array.isArray(packets) ? packets : [packets]) handlePacket(session, packet);
      } catch { session.error = 'Unreadable tracker response'; emit(); }
    });
    socket.addEventListener('close', () => { if (session.socket === socket) session.socket = null; scheduleReconnect(session, token); });
    socket.addEventListener('error', () => {});
  }

  function stop() {
    stopped = true; generation += 1;
    for (const session of sessions.values()) {
      session.manualClose = true;
      if (session.retryTimer) clearTimer(session.retryTimer);
      try { session.socket?.close(); } catch { /* Already closed. */ }
    }
    sessions.clear(); packages.clear(); aliases.clear(); room = undefined;
  }

  function start(config) {
    stop();
    room = { roomId: String(config.roomId || ''), port: Number(config.port), password: String(config.password || '') };
    if (!room.roomId || !Number.isInteger(room.port) || room.port < 1 || room.port > 65535) throw new Error('Invalid tracker sidecar room configuration.');
    stopped = false;
    const token = generation;
    for (const source of config.slots || []) {
      const slot = Number(source.slot);
      const name = String(source.name || '').trim();
      const game = String(source.game || '').trim();
      if (!Number.isInteger(slot) || slot < 1 || !name || !game || sessions.has(slot)) continue;
      sessions.set(slot, { slot, name, game, checked: new Set(), locations: new Set(), hints: new Map(), itemsReceived: 0, status: 0, retry: 0, retryTimer: null, socket: null, manualClose: false });
    }
    for (const session of sessions.values()) connect(session, token);
    emit();
    return snapshot();
  }

  return { start, stop, snapshot, get running() { return !stopped; }, get roomId() { return room?.roomId; } };
}

module.exports = { createTrackerSidecar, hintObject, classification };
