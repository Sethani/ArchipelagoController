import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTrackerSidecar } = require('./tracker-sidecar.cjs');

class FakeSocket {
  static instances = [];
  readyState = 1;
  listeners = new Map();
  sent = [];
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.listeners.get('close')?.({}); }
  receive(...packets) { this.listeners.get('message')?.({ data: JSON.stringify(packets) }); }
}

describe('local tracker sidecar', () => {
  it('collects exact checks, items, status, names, and hints without sending game actions', () => {
    FakeSocket.instances = [];
    const updates = [];
    const sidecar = createTrackerSidecar({ createSocket: (url) => new FakeSocket(url), onUpdate: (value) => updates.push(value), now: () => '2026-10-21T12:00:00.000Z' });
    sidecar.start({ roomId: 'local-room', port: 38281, password: 'secret', slots: [
      { slot: 1, name: 'Sethiduck_MC', game: 'Minecraft' },
      { slot: 2, name: 'Sethiduck_MF', game: 'Metroid Fusion' },
    ] });
    const minecraft = FakeSocket.instances[0];
    expect(minecraft.url).toBe('ws://127.0.0.1:38281');
    minecraft.receive({ cmd: 'RoomInfo' });
    const connect = minecraft.sent.flat().find((packet) => packet.cmd === 'Connect');
    expect(connect).toMatchObject({ name: 'Sethiduck_MC', password: 'secret', items_handling: 7, tags: ['AP', 'IgnoreGame', 'Tracker', 'NoText'] });
    minecraft.receive({ cmd: 'Connected', team: 0, slot: 2, checked_locations: [101], missing_locations: [102, 103], players: [
      { slot: 2, name: 'Sethiduck_MC', alias: 'Sethiduck' }, { slot: 1, name: 'Sethiduck_MF', alias: 'Fusion' },
    ] });
    const fusion = FakeSocket.instances[1];
    fusion.receive({ cmd: 'RoomInfo' });
    fusion.receive({ cmd: 'Connected', team: 0, slot: 1, checked_locations: [], missing_locations: [] });
    expect(minecraft.sent.flat().map((packet) => packet.cmd)).toEqual(expect.arrayContaining(['GetDataPackage', 'SetNotify', 'Get']));
    minecraft.receive({ cmd: 'DataPackage', data: { games: { Minecraft: { item_name_to_id: { Diamond: 201 }, location_name_to_id: { Chest: 101 } }, 'Metroid Fusion': { item_name_to_id: { Missile: 301 }, location_name_to_id: { Sector: 401 } } } } });
    minecraft.receive({ cmd: 'ReceivedItems', index: 0, items: [{ item: 1 }, { item: 2 }] });
    minecraft.receive({ cmd: 'RoomUpdate', checked_locations: [102] });
    minecraft.receive({ cmd: 'Retrieved', keys: {
      '_read_client_status_0_2': 30,
      '_read_hints_0_2': [{ receiving_player: 2, finding_player: 1, location: 401, item: 201, found: false, item_flags: 1, status: 30 }],
    } });
    const snapshot = sidecar.snapshot();
    expect(snapshot).toMatchObject({ roomId: 'local-room', checksDone: 2, checksTotal: 3, completedPlayers: 1, unresolvedHints: 1 });
    expect(snapshot.players.find((player) => player.name === 'Sethiduck_MC')).toMatchObject({ slot: 2, alias: 'Sethiduck', itemsReceived: 2, statusLabel: 'Finished' });
    expect(snapshot.hints[0]).toMatchObject({ item: 'Diamond', location: 'Sector', receivingName: 'Sethiduck', findingName: 'Fusion', classification: 'Progression', statusLabel: 'Priority' });
    expect(updates.length).toBeGreaterThan(1);
    expect(minecraft.sent.flat().some((packet) => ['LocationChecks', 'StatusUpdate', 'Say'].includes(packet.cmd))).toBe(false);
    sidecar.stop();
    expect(sidecar.running).toBe(false);
  });

  it('retries closed sockets with bounded timers', () => {
    FakeSocket.instances = [];
    const callbacks = [];
    const sidecar = createTrackerSidecar({ createSocket: (url) => new FakeSocket(url), setTimer: (callback, delay) => { callbacks.push({ callback, delay }); return callbacks.length; }, clearTimer: vi.fn() });
    sidecar.start({ roomId: 'retry-room', port: 38281, slots: [{ slot: 1, name: 'Player', game: 'Game' }] });
    FakeSocket.instances[0].close();
    expect(callbacks[0].delay).toBe(1000);
    callbacks[0].callback();
    expect(FakeSocket.instances).toHaveLength(2);
    sidecar.stop();
  });

  it('opens only one tracker session for duplicate configured slots', () => {
    FakeSocket.instances = [];
    const sidecar = createTrackerSidecar({ createSocket: (url) => new FakeSocket(url) });
    const snapshot = sidecar.start({ roomId: 'duplicate-room', port: 38281, slots: [
      { slot: 1, name: 'Player_MC', game: 'Minecraft' },
      { slot: 1, name: 'Player_MC', game: 'Minecraft' },
      { slot: 2, name: 'player_mc', game: 'Minecraft' },
      { slot: 3, name: 'Player_TW', game: 'The Witness' },
    ] });
    expect(FakeSocket.instances).toHaveLength(2);
    expect(snapshot.players.map((player) => player.name)).toEqual(['Player_MC', 'Player_TW']);
    sidecar.stop();
  });
});
