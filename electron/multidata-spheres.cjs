const { createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { unzipSync } = require('fflate');

const MAX_COMPRESSED = 64 * 1024 * 1024;
const MAX_DECODED = 256 * 1024 * 1024;
const MAX_COLLECTION = 2_000_000;
const MAX_DEPTH = 80;
const MARK = Symbol('pickle-mark');
const ALLOWED_GLOBALS = new Set([
  'builtins.set', 'builtins.frozenset', 'collections.Counter', 'collections.defaultdict',
  'NetUtils.NetworkSlot', 'NetUtils.SlotType', 'NetUtils.Hint', 'NetUtils.HintStatus',
  'NetUtils.NetworkItem', 'NetUtils.ClientStatus', 'NetUtils.Version',
]);

function safeGlobal(module, name) {
  const key = `${module}.${name}`;
  if (!ALLOWED_GLOBALS.has(key) && !module.startsWith('Options.')) throw new Error(`Unsupported pickle global ${key}.`);
  return { __global: key };
}

function assertCollection(value) {
  const size = value instanceof Map || value instanceof Set ? value.size : Array.isArray(value) ? value.length : Object.keys(value || {}).length;
  if (size > MAX_COLLECTION) throw new Error('Multidata collection exceeds the safety limit.');
}

function decodePickle(buffer) {
  let offset = 0;
  let objects = 0;
  const stack = [];
  const memo = new Map();
  const read = (count) => { if (offset + count > buffer.length) throw new Error('Truncated pickle.'); const value = buffer.subarray(offset, offset + count); offset += count; return value; };
  const u8 = () => read(1)[0];
  const u16 = () => read(2).readUInt16LE(0);
  const u32 = () => read(4).readUInt32LE(0);
  const u64 = () => { const value = read(8).readBigUInt64LE(0); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Pickle integer is too large.'); return Number(value); };
  const line = () => { const end = buffer.indexOf(0x0a, offset); if (end < 0) throw new Error('Truncated pickle line.'); const value = buffer.subarray(offset, end).toString('utf8'); offset = end + 1; return value; };
  const mark = () => { const index = stack.lastIndexOf(MARK); if (index < 0) throw new Error('Pickle MARK is missing.'); return index; };
  const items = () => { const index = mark(); const values = stack.splice(index + 1); stack.pop(); return values; };
  const push = (value) => { objects += 1; if (objects > MAX_COLLECTION * 4) throw new Error('Multidata object count exceeds the safety limit.'); stack.push(value); };
  const pairObject = (values) => { if (values.length % 2) throw new Error('Malformed pickle dictionary.'); const result = {}; for (let i = 0; i < values.length; i += 2) result[String(values[i])] = values[i + 1]; assertCollection(result); return result; };
  const reduce = (callable, args) => {
    if (!callable?.__global) throw new Error('Unsafe pickle reducer.');
    if (callable.__global === 'builtins.set') return new Set(args?.[0] || []);
    if (callable.__global === 'builtins.frozenset') return new Set(args?.[0] || []);
    if (callable.__global === 'collections.Counter') return { ...(args?.[0] || {}) };
    if (callable.__global === 'collections.defaultdict') return { ...(args?.[1] || {}) };
    return { __type: callable.__global, args: Array.isArray(args) ? args : [args] };
  };
  while (offset < buffer.length) {
    const opcode = u8();
    if (opcode === 0x2e) { if (stack.length !== 1) throw new Error('Malformed pickle stack.'); return stack[0]; }
    if (opcode === 0x80) { const protocol = u8(); if (protocol > 5) throw new Error(`Unsupported pickle protocol ${protocol}.`); continue; }
    if (opcode === 0x95) { u64(); continue; }
    if (opcode === 0x28) { stack.push(MARK); if (stack.filter((item) => item === MARK).length > MAX_DEPTH) throw new Error('Multidata nesting exceeds the safety limit.'); continue; }
    if (opcode === 0x4e) push(null);
    else if (opcode === 0x88) push(true);
    else if (opcode === 0x89) push(false);
    else if (opcode === 0x4b) push(u8());
    else if (opcode === 0x4d) push(u16());
    else if (opcode === 0x4a) push(read(4).readInt32LE(0));
    else if (opcode === 0x47) push(read(8).readDoubleBE(0));
    else if (opcode === 0x8a || opcode === 0x8b) {
      const length = opcode === 0x8a ? u8() : u32();
      const bytes = read(length); let value = 0n;
      for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
      if (bytes.length && (bytes.at(-1) & 0x80)) value -= 1n << BigInt(bytes.length * 8);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Pickle integer is too large.');
      push(Number(value));
    } else if (opcode === 0x8c) push(read(u8()).toString('utf8'));
    else if (opcode === 0x58) push(read(u32()).toString('utf8'));
    else if (opcode === 0x8d) push(read(u64()).toString('utf8'));
    else if (opcode === 0x43) push(Buffer.from(read(u8())));
    else if (opcode === 0x42) push(Buffer.from(read(u32())));
    else if (opcode === 0x96) push(Buffer.from(read(u64())));
    else if (opcode === 0x5d) push([]);
    else if (opcode === 0x7d) push({});
    else if (opcode === 0x29) push([]);
    else if (opcode === 0x8f) push(new Set());
    else if (opcode === 0x6c) push(items());
    else if (opcode === 0x74) push(items());
    else if (opcode === 0x85) push([stack.pop()]);
    else if (opcode === 0x86) { const right = stack.pop(); const left = stack.pop(); push([left, right]); }
    else if (opcode === 0x87) { const c = stack.pop(); const b = stack.pop(); const a = stack.pop(); push([a, b, c]); }
    else if (opcode === 0x64) push(pairObject(items()));
    else if (opcode === 0x61) { const value = stack.pop(); const list = stack.at(-1); if (!Array.isArray(list)) throw new Error('APPEND target is not a list.'); list.push(value); assertCollection(list); }
    else if (opcode === 0x65) { const values = items(); const list = stack.at(-1); if (!Array.isArray(list)) throw new Error('APPENDS target is not a list.'); list.push(...values); assertCollection(list); }
    else if (opcode === 0x73) { const value = stack.pop(); const key = stack.pop(); const target = stack.at(-1); target[String(key)] = value; assertCollection(target); }
    else if (opcode === 0x75) { const values = items(); const target = stack.at(-1); Object.assign(target, pairObject(values)); assertCollection(target); }
    else if (opcode === 0x90) { const values = items(); const target = stack.at(-1); if (!(target instanceof Set)) throw new Error('ADDITEMS target is not a set.'); for (const value of values) target.add(value); assertCollection(target); }
    else if (opcode === 0x91) push(new Set(items()));
    else if (opcode === 0x71) memo.set(u8(), stack.at(-1));
    else if (opcode === 0x72) memo.set(u32(), stack.at(-1));
    else if (opcode === 0x94) memo.set(memo.size, stack.at(-1));
    else if (opcode === 0x68) { const value = memo.get(u8()); if (value === undefined) throw new Error('Invalid pickle memo reference.'); stack.push(value); }
    else if (opcode === 0x6a) { const value = memo.get(u32()); if (value === undefined) throw new Error('Invalid pickle memo reference.'); stack.push(value); }
    else if (opcode === 0x63) push(safeGlobal(line(), line()));
    else if (opcode === 0x93) { const name = stack.pop(); const module = stack.pop(); push(safeGlobal(String(module), String(name))); }
    else if (opcode === 0x52) { const args = stack.pop(); const callable = stack.pop(); push(reduce(callable, args)); }
    else if (opcode === 0x81) { const args = stack.pop(); const callable = stack.pop(); push(reduce(callable, args)); }
    else if (opcode === 0x62) { const state = stack.pop(); const target = stack.at(-1); if (!target || typeof target !== 'object') throw new Error('Invalid pickle BUILD target.'); target.state = state; }
    else if (opcode === 0x30) stack.pop();
    else if (opcode === 0x31) { const index = mark(); stack.splice(index); }
    else throw new Error(`Unsupported pickle opcode 0x${opcode.toString(16)}.`);
  }
  throw new Error('Pickle has no STOP opcode.');
}

function archiveMultidata(buffer) {
  if (buffer.length > MAX_COMPRESSED) throw new Error('Session artifact exceeds the multidata safety limit.');
  let bytes = buffer;
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const entries = unzipSync(new Uint8Array(buffer));
    const names = Object.keys(entries).filter((name) => name.toLowerCase().endsWith('.archipelago'));
    if (names.length !== 1) throw new Error(names.length ? 'Session archive contains multiple multidata files.' : 'Session archive has no multidata file.');
    bytes = Buffer.from(entries[names[0]]);
  }
  if (bytes[0] !== 3) throw new Error(`Unsupported multidata container version ${bytes[0] ?? 'unknown'}.`);
  const decoded = inflateSync(bytes.subarray(1), { maxOutputLength: MAX_DECODED });
  return { hash: createHash('sha256').update(bytes).digest('hex'), value: decodePickle(decoded) };
}

function recordArgs(value) { return value?.args || []; }
function slotDescriptor(multidata, slot, trackerPlayer) {
  const raw = multidata.slot_info?.[String(slot)];
  const args = recordArgs(raw);
  return { name: trackerPlayer?.name || args[0] || `Slot ${slot}`, game: trackerPlayer?.game || args[1] || 'Unknown' };
}
function invertNames(value) { return new Map(Object.entries(value || {}).map(([name, id]) => [Number(id), name])); }

function checkedSphereSnapshot(multidata, tracker) {
  if (!Array.isArray(multidata?.spheres)) return { available: false, reason: 'absent', checks: [] };
  const players = new Map((tracker?.players || []).map((player) => [Number(player.slot), player]));
  const checks = [];
  for (let index = 0; index < multidata.spheres.length; index += 1) {
    const sphere = multidata.spheres[index] || {};
    for (const [finderKey, locations] of Object.entries(sphere)) {
      const finderSlot = Number(finderKey);
      const checked = new Set(players.get(finderSlot)?.checkedLocationIds || []);
      for (const locationId of locations instanceof Set ? locations : locations || []) {
        if (!checked.has(Number(locationId))) continue;
        const placement = multidata.locations?.[finderKey]?.[String(locationId)] || [];
        const itemId = Number(placement[0]);
        const receiverSlot = Number(placement[1] || finderSlot);
        const finder = slotDescriptor(multidata, finderSlot, players.get(finderSlot));
        const receiver = slotDescriptor(multidata, receiverSlot, players.get(receiverSlot));
        const finderPackage = multidata.datapackage?.[finder.game] || {};
        const receiverPackage = multidata.datapackage?.[receiver.game] || {};
        checks.push({
          sphere: index + 1, finderSlot, finderName: finder.name, finderGame: finder.game,
          receiverSlot, receiverName: receiver.name, receiverGame: receiver.game,
          itemId, item: invertNames(receiverPackage.item_name_to_id).get(itemId) || `Item ${itemId}`,
          locationId: Number(locationId), location: invertNames(finderPackage.location_name_to_id).get(Number(locationId)) || `Location ${locationId}`,
        });
      }
    }
  }
  return { available: true, checks };
}

function completeSphereSnapshot(multidata) {
  if (!Array.isArray(multidata?.spheres)) return { available: false, reason: 'absent', checks: [] };
  const checkedBySlot = new Map();
  for (const sphere of multidata.spheres) {
    for (const [slot, locations] of Object.entries(sphere || {})) {
      const ids = checkedBySlot.get(Number(slot)) || [];
      ids.push(...[...(locations instanceof Set ? locations : locations || [])].map(Number));
      checkedBySlot.set(Number(slot), ids);
    }
  }
  return checkedSphereSnapshot(multidata, {
    players: [...checkedBySlot].map(([slot, checkedLocationIds]) => {
      const descriptor = slotDescriptor(multidata, slot);
      return { slot, ...descriptor, checkedLocationIds };
    }),
  });
}

module.exports = { MAX_COMPRESSED, MAX_DECODED, archiveMultidata, checkedSphereSnapshot, completeSphereSnapshot, decodePickle };
