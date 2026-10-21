const MAX_EVENTS = 120;
const MAX_HINTS = 80;

function safeLine(value) {
  return String(value ?? '')
    .replace(/(!admin\s+login)\s+\S+/ig, '$1 [redacted]')
    .replace(/((?:server|room)[ _-]?password\s*[:=]\s*)\S+/ig, '$1[redacted]')
    .replace(/(password\s+is\s+)\S+/ig, '$1[redacted]')
    .trim()
    .slice(0, 1000);
}

function createRoomLiveState(slots, clock = () => new Date().toISOString()) {
  const players = new Map((slots ?? []).map((slot) => [Number(slot.slot), {
    slot: Number(slot.slot), name: String(slot.name), game: String(slot.game), connected: Boolean(slot.connected),
    checksSeen: 0, itemsSeen: 0, status: 'Not connected', lastActivityAt: undefined,
  }]));
  const events = [];
  const hints = [];
  const seenChecks = new Set();
  const ordered = [...players.values()].sort((a, b) => b.name.length - a.name.length);

  function matchingPlayers(line) {
    const lower = line.toLocaleLowerCase();
    return ordered.filter((player) => lower.includes(player.name.toLocaleLowerCase()));
  }

  function addEvent(type, message, player, timestamp) {
    events.unshift({ id: `${timestamp}:${events.length}:${type}`, type, message, slot: player?.slot, timestamp });
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  }

  function update(raw) {
    const line = safeLine(raw);
    if (!line || /!admin\s+login/i.test(line)) return;
    const timestamp = clock();
    const matched = matchingPlayers(line);
    const primary = matched[0];
    if (primary) primary.lastActivityAt = timestamp;

    if (primary && /\b(joined|connected)\b/i.test(line) && !/rejected|failed|disconnected/i.test(line)) {
      primary.connected = true;
      primary.status = 'Connected';
      addEvent('connection', `${primary.name} connected`, primary, timestamp);
      return;
    }
    if (primary && /\b(left|disconnected|connection closed)\b/i.test(line)) {
      primary.connected = false;
      primary.status = 'Not connected';
      addEvent('connection', `${primary.name} disconnected`, primary, timestamp);
      return;
    }
    if (/\bhint(?:ed)?\b|\[hint\]/i.test(line)) {
      const hint = { id: `${timestamp}:${hints.length}`, message: line, slot: primary?.slot, found: /\b(found|checked)\b/i.test(line), timestamp };
      hints.unshift(hint);
      if (hints.length > MAX_HINTS) hints.length = MAX_HINTS;
      addEvent('hint', line, primary, timestamp);
      return;
    }
    if (primary && /\b(goal|finished|completed)\b/i.test(line)) {
      primary.status = 'Finished';
      addEvent('goal', line, primary, timestamp);
      return;
    }
    if (primary && /\b(checked|location check|found (?:their|a))\b/i.test(line)) {
      const key = line.toLocaleLowerCase();
      if (!seenChecks.has(key)) { primary.checksSeen += 1; seenChecks.add(key); }
      addEvent('check', line, primary, timestamp);
      return;
    }
    if (primary && /\b(sent|received)\b.*\b(item|from|to)\b|\bitem\b.*\b(sent|received)\b/i.test(line)) {
      primary.itemsSeen += 1;
      addEvent('item', line, primary, timestamp);
      return;
    }
    if (/\b(joined|left|sent|received|checked|hint|goal|finished)\b/i.test(line)) addEvent('room', line, primary, timestamp);
  }

  function snapshot() {
    const list = [...players.values()].sort((a, b) => a.slot - b.slot).map((player) => ({ ...player }));
    return {
      players: list,
      checksSeen: list.reduce((sum, player) => sum + player.checksSeen, 0),
      itemsSeen: list.reduce((sum, player) => sum + player.itemsSeen, 0),
      completedPlayers: list.filter((player) => player.status === 'Finished').length,
      hints: hints.map((hint) => ({ ...hint })),
      unresolvedHints: hints.filter((hint) => !hint.found).length,
      events: events.map((event) => ({ ...event })),
    };
  }

  return { update, snapshot };
}

module.exports = { MAX_EVENTS, MAX_HINTS, createRoomLiveState, safeLine };
