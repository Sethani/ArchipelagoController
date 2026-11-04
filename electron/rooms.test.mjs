import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const { adoptLocalRun, archiveSlotSummary, connectionUri, ensureRoom, inside, normalizeRoomStatus, normalizeTrackerDashboard, parseControllerInvite, parseRoomUrl, patchArchive, prepareFile, refreshControllerRoom, sharedSlotInventory, sphereTrackerUrl, trackerUrl, uniqueSlots } = require('./rooms.cjs');
const temporary = [];

afterEach(async () => Promise.all(temporary.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))));

describe('room links and status', () => {
  it('deduplicates slots by AP slot id or normalized slot name', () => {
    expect(uniqueSlots([
      { slot: 1, name: 'Player_MC', game: 'Minecraft', files: [{ id: 'a' }] },
      { slot: 1, name: 'Player_MC', game: 'Minecraft', files: [{ id: 'b' }] },
      { slot: 2, name: 'player_mc', game: 'Minecraft', files: [{ id: 'c' }] },
      { slot: 3, name: 'Player_TW', game: 'The Witness', files: [] },
    ])).toEqual([
      expect.objectContaining({ slot: 1, name: 'Player_MC', files: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
      expect.objectContaining({ slot: 3, name: 'Player_TW' }),
    ]);
  });

  it('accepts only canonical official room links', () => {
    expect(parseRoomUrl('https://archipelago.gg/room/wDTli-QPTyG76HjQiab0aw')).toMatchObject({ id: 'wDTli-QPTyG76HjQiab0aw' });
    expect(() => parseRoomUrl('http://archipelago.gg/room/wDTli-QPTyG76HjQiab0aw')).toThrow(/Only https/);
    expect(() => parseRoomUrl('https://example.com/room/wDTli-QPTyG76HjQiab0aw')).toThrow(/Only https/);
    expect(() => parseRoomUrl('https://archipelago.gg/room/wDTli-QPTyG76HjQiab0aw?x=1')).toThrow(/canonical/);
  });

  it('normalizes both room player tuple formats and downloads', () => {
    const room = parseRoomUrl('https://archipelago.gg/room/wDTli-QPTyG76HjQiab0aw');
    const result = normalizeRoomStatus({ tracker: 'tracker_id', last_port: 45678, players: [['Sethiduck', 'VVVVVV'], [3, 'Melodie', 'Minecraft']], downloads: [{ slot: 1, download: '/slot/1' }] }, room);
    expect(result.lastPort).toBe(45678);
    expect(result.slots).toEqual([
      { slot: 1, name: 'Sethiduck', game: 'VVVVVV', downloadAvailable: true },
      { slot: 3, name: 'Melodie', game: 'Minecraft', downloadAvailable: false },
    ]);
  });

  it('builds encoded login and tracker URLs', () => {
    expect(connectionUri('Slot Name', 'p@ss', 41234, 'A Link to the Past')).toBe('archipelago://Slot%20Name:p%40ss@archipelago.gg:41234?game=A%20Link%20to%20the%20Past');
    expect(connectionUri('Sethiduck_Locks', '', 61039, 'SlotLock')).toBe('archipelago://Sethiduck_Locks:@archipelago.gg:61039?game=SlotLock');
    expect(trackerUrl('https://archipelago.gg/room/wDTli-QPTyG76HjQiab0aw', 'tracker_123', 4)).toBe('https://archipelago.gg/tracker/tracker_123/0/4');
    expect(sphereTrackerUrl('https://archipelago.gg/room/wDTli-QPTyG76HjQiab0aw', 'tracker_123')).toBe('https://archipelago.gg/sphere_tracker/tracker_123');
  });

  it('combines live tracker progress, totals, statuses, and named hints', () => {
    const dynamic = {
      aliases: [{ player: 1, alias: 'Sethi' }],
      player_checks_done: [{ player: 1, locations: [10, 11] }, { player: 2, locations: [20] }],
      player_items_received: [{ player: 1, items: [[7, 20, 2, 1]] }, { player: 2, items: [] }],
      player_status: [{ player: 1, status: 20 }, { player: 2, status: 30 }],
      activity_timers: [{ player: 1, time: 'Tue, 20 Oct 2026 18:00:00 GMT' }],
      connection_timers: [], total_checks_done: [{ team: 0, checks_done: 3 }],
      hints: [{ player: 1, hints: [[1, 2, 20, 7, false, '', 1, 30]] }, { player: 2, hints: [[1, 2, 20, 7, false, '', 1, 30]] }],
    };
    const fixed = { player_locations_total: [{ player: 1, total_locations: 10 }, { player: 2, total_locations: 5 }], player_game: [] };
    const result = normalizeTrackerDashboard(dynamic, fixed, [
      { slot: 1, name: 'Sethiduck', game: 'Game A' }, { slot: 2, name: 'Melodie', game: 'Game B' },
    ], {
      'Game A': { item_name_to_id: { 'Useful Key': 7 } },
      'Game B': { location_name_to_id: { 'Hidden Cave': 20 } },
    });
    expect(result).toMatchObject({ checksDone: 3, checksTotal: 15, completedPlayers: 1, unresolvedHints: 1 });
    expect(result.players[0]).toMatchObject({ alias: 'Sethi', checksDone: 2, checksTotal: 10, statusLabel: 'Playing', unresolvedHintCount: 1 });
    expect(result.hints[0]).toMatchObject({ item: 'Useful Key', location: 'Hidden Cave', receivingName: 'Sethi', findingName: 'Melodie', statusLabel: 'Priority' });
  });

  it('parses browser and Controller invitations as stable room URLs', () => {
    const browser = 'http://rooms.example.test:38282/room/local-123456#token=secret_value';
    expect(parseControllerInvite(browser)).toEqual({ id: 'local-123456', url: 'http://rooms.example.test:38282/room/local-123456', origin: 'http://rooms.example.test:38282' });
    expect(parseControllerInvite(`archipelago-controller://join?url=${encodeURIComponent(browser)}`)).toMatchObject({ id: 'local-123456', url: 'http://rooms.example.test:38282/room/local-123456' });
  });

  it('builds connection URIs for non-official room providers', () => {
    expect(connectionUri('Player', 'pw', 'games.example.test', 38281, 'Test Game')).toBe('archipelago://Player:pw@games.example.test:38281?game=Test%20Game');
  });

  it('negotiates Controller API v2 and preserves the rich snapshot', async () => {
    const snapshot = {
      apiVersion: 2, refreshedAt: '2026-11-03T18:00:00.000Z', stale: false,
      original: { endpoint: { host: 'rooms.example.test', port: 443, secure: true }, slots: [{ slot: 1, name: 'Player', game: 'Game', files: [{ id: 'file_123456', name: 'player.apgame', size: 12, kind: 'downloaded', sourceId: 'file_123456', revision: 'r1' }] }] },
      enriched: { capabilities: { apiVersion: 2, progress: true, hints: true, activity: true, spheres: false, multipleFiles: true, browserTrackers: true, logicAnalysis: true, remoteWake: false }, dashboard: { players: [] } },
    };
    const net = { fetch: async (url) => new Response(JSON.stringify(snapshot), { status: url.includes('/v2/') ? 200 : 500, headers: { 'content-type': 'application/json' } }) };
    const result = await refreshControllerRoom(net, 'https://rooms.example.test/room/local-123456');
    expect(result).toMatchObject({ lastPort: 443, capabilities: { apiVersion: 2 }, slots: [{ downloadAvailable: true }] });
    expect(result.snapshot).toEqual(snapshot);
    expect(result.slots[0].remoteFiles).toHaveLength(1);
  });

  it('falls back visibly to a limited v1 Controller host', async () => {
    const net = { fetch: async (url) => url.includes('/v2/')
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ apiVersion: 1, endpoint: { host: 'old.example', port: 38281 }, slots: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) };
    expect(await refreshControllerRoom(net, 'https://rooms.example.test/room/local-123456')).toMatchObject({ limitedHost: true, capabilities: { apiVersion: 1 } });
  });
});

describe('room files', () => {
  it('keeps fileless games visible while restricting downloads to approved slots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'controller-room-'));
    temporary.push(root);
    const folder = await ensureRoom(root, 'Local Room', 'local-visible-123');
    const minecraftFolder = path.join(folder, 'downloads', 'Minecraft_Player');
    await mkdir(minecraftFolder, { recursive: true });
    await writeFile(path.join(minecraftFolder, 'Minecraft_Player.apmc'), 'patch');
    const slots = await sharedSlotInventory({
      roomsRoot: root, folderPath: folder, sharedSlots: [1],
      slots: [{ slot: 1, name: 'Minecraft_Player', game: 'Minecraft' }, { slot: 2, name: 'Witness_Player', game: 'The Witness' }],
    });
    expect(slots).toHaveLength(2);
    expect(slots[0].files).toHaveLength(1);
    expect(slots[1]).toMatchObject({ name: 'Witness_Player', game: 'The Witness', files: [] });
  });

  it('constrains room paths to the configured root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'controller-room-'));
    temporary.push(root);
    const folder = await ensureRoom(root, 'Game Night', 'wDTli-QPTyG76HjQiab0aw');
    expect(folder.startsWith(root)).toBe(true);
    expect(() => inside(root, path.join(root, '..', 'elsewhere'))).toThrow(/outside/);
  });

  it('rewrites only the working patch manifest', async () => {
    const manifest = { game: 'VVVVVV', player: 1, player_name: 'Sethiduck', server: 'old.example:1' };
    const sourceBytes = Buffer.from(zipSync({ 'archipelago.json': Buffer.from(JSON.stringify(manifest)), 'payload.bin': new Uint8Array([1, 2, 3]) }));
    const root = await mkdtemp(path.join(os.tmpdir(), 'controller-room-'));
    temporary.push(root);
    const folder = await ensureRoom(root, 'Game Night', 'wDTli-QPTyG76HjQiab0aw');
    const downloadFolder = path.join(folder, 'downloads', 'Sethiduck');
    await import('node:fs/promises').then(({ mkdir, writeFile }) => mkdir(downloadFolder, { recursive: true }).then(() => writeFile(path.join(downloadFolder, 'game.apvvv'), sourceBytes)));

    const prepared = await prepareFile({ roomsRoot: root, folderPath: folder, sourcePath: path.join(downloadFolder, 'game.apvvv'), slot: 1, slotName: 'Sethiduck', game: 'VVVVVV' }, 'archipelago.gg:45678');
    const original = unzipSync(new Uint8Array(await readFile(path.join(downloadFolder, 'game.apvvv'))));
    const working = unzipSync(new Uint8Array(await readFile(prepared.file.path)));
    expect(JSON.parse(Buffer.from(original['archipelago.json']).toString()).server).toBe('old.example:1');
    expect(JSON.parse(Buffer.from(working['archipelago.json']).toString()).server).toBe('archipelago.gg:45678');
    expect([...working['payload.bin']]).toEqual([1, 2, 3]);
  });

  it('rejects unsafe archive paths', () => {
    const archive = Buffer.from(zipSync({ '../escape': new Uint8Array([1]), 'archipelago.json': Buffer.from('{}') }));
    expect(() => patchArchive(archive, 'archipelago.gg:1')).toThrow(/Unsafe ZIP entry/);
  });

  it('discovers slot metadata inside an existing generated archive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'controller-room-'));
    temporary.push(root);
    const patch = Buffer.from(zipSync({ 'archipelago.json': Buffer.from(JSON.stringify({ game: 'VVVVVV', player_name: 'Sethiduck_V' })) }));
    const archive = path.join(root, 'AP_123.zip');
    await writeFile(archive, Buffer.from(zipSync({ 'AP_123_P1_Sethiduck_V.apvvv': patch })));
    expect(await archiveSlotSummary(archive)).toEqual({ playerCount: 1, slotCount: 1, games: ['VVVVVV'], slots: [{ name: 'Sethiduck_V', game: 'VVVVVV' }] });
  });

  it('adopts matching slot patches without exposing protected session files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'controller-room-'));
    temporary.push(root);
    const patch = Buffer.from(zipSync({ 'archipelago.json': Buffer.from(JSON.stringify({ game: 'VVVVVV', player_name: 'Sethiduck_V' })) }));
    const archive = path.join(root, 'AP_123.zip');
    await writeFile(archive, Buffer.from(zipSync({
      'AP_123_P1_Sethiduck_V.apvvv': patch,
      'AP_123.archipelago': new Uint8Array([4, 5, 6]),
      'AP_123_Spoiler.txt': Buffer.from('secret'),
    })));
    const adopted = await adoptLocalRun({ roomsRoot: path.join(root, 'Rooms'), roomId: 'local-test-123', label: 'Test', sessionPath: archive, artifactPath: archive, slots: [{ slot: 1, name: 'Sethiduck_V', game: 'VVVVVV' }] });
    expect(adopted.slots[0].downloadAvailable).toBe(true);
    expect(adopted.slots[0].files.map((file) => file.name)).toEqual(['AP_123_P1_Sethiduck_V.apvvv']);
  });
});
