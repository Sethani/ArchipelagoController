import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync, zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const { createRoomPortal, withTimeout } = require('./room-portal.cjs');
const { patchArchive } = require('./rooms.cjs');
const roots = [];
const portals = [];

afterEach(async () => {
  await Promise.all(portals.splice(0).map((portal) => portal.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Controller room portal', () => {
  it('bounds network operations that do not settle', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'mapping timed out')).rejects.toThrow('mapping timed out');
    await expect(withTimeout(Promise.resolve('ready'), 100, 'too slow')).resolves.toBe('ready');
  });

  it('runs the listening hook before automatic mapping', async () => {
    const portal = createRoomPortal({ patchArchive });
    portals.push(portal);
    let listening = false;
    const result = await portal.start({
      roomId: 'room-hook-123', label: 'Hook Room', generationId: 'seed-hook', portalPort: 0,
      automaticPortMapping: false, serverRunning: false,
      endpoint: { host: 'example.test', port: 38281, secure: true }, slots: [],
    }, () => { listening = portal.running; });
    expect(listening).toBe(true);
    expect(result.mapping).toBe('disabled');
  });

  it('uses the random room URL and patches only the downloaded copy', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'controller-portal-'));
    roots.push(root);
    const source = path.join(root, 'player.apgame');
    const original = Buffer.from(zipSync({
      'archipelago.json': Buffer.from(JSON.stringify({ game: 'Test Game', player_name: 'Player' })),
      'payload.bin': new Uint8Array([1, 2, 3]),
    }));
    await writeFile(source, original);
    const portal = createRoomPortal({ patchArchive });
    portals.push(portal);
    const result = await portal.start({
      roomId: 'room-test-123', label: 'Test Room', generationId: 'seed-1', portalPort: 0,
      automaticPortMapping: false, serverRunning: true, passwordRequired: true, createdAt: '2026-10-20T08:00:00.000Z',
      endpoint: { host: 'example.test', port: 38281, secure: false },
      slots: [{ slot: 1, name: 'Player', game: 'Test Game', files: [{ id: 'file_test_123', name: 'player.apgame', path: source, kind: 'downloaded', size: original.length }] }],
    });
    const base = `http://127.0.0.1:${result.portalPort}/api/controller/v1/room/room-test-123`;
    const rootResponse = await fetch(`http://127.0.0.1:${result.portalPort}/`, { redirect: 'manual' });
    expect(rootResponse.status).toBe(302);
    expect(rootResponse.headers.get('location')).toBe('/room/room-test-123');
    const roomPage = await (await fetch(`http://127.0.0.1:${result.portalPort}/room/room-test-123`)).text();
    expect(roomPage).toContain('Multiworld progress');
    expect(roomPage).toContain('Hinted items');
    expect(roomPage).toContain('Recent room activity');
    expect(roomPage).toContain('Sphere tracker');
    expect(roomPage).toContain('Open in Controller');
    const status = await (await fetch(`${base}/status`)).json();
    expect(status).toMatchObject({ apiVersion: 1, provider: 'controller', label: 'Test Room', state: 'Online', passwordRequired: true, createdAt: '2026-10-20T08:00:00.000Z', endpoint: { host: 'example.test', port: 38281 }, progress: { checksSeen: 0, itemsSeen: 0, totalsAvailable: false } });
    expect(status.startedAt).toBeTruthy();
    portal.updatePresence('Player joined the game');
    portal.updatePresence('Player checked Test Location');
    portal.updatePresence('[Hint]: Player was hinted Test Item at Test Location');
    const activeStatus = await (await fetch(`${base}/status`)).json();
    expect(activeStatus.slots[0].connected).toBe(true);
    expect(activeStatus.progress).toMatchObject({ checksSeen: 1, unresolvedHints: 1 });
    expect(activeStatus.activity).toHaveLength(3);
    expect(activeStatus.hints).toHaveLength(1);
    portal.updateTracker({ roomId: 'room-test-123', refreshedAt: '2026-10-20T09:00:00.000Z', checksDone: 7, checksTotal: 12, completedPlayers: 1, unresolvedHints: 1,
      players: [{ slot: 2, name: 'Player', checksDone: 7, checksTotal: 12, itemsReceived: 4, statusLabel: 'Finished', lastActivity: '2026-10-20T09:00:00.000Z' }],
      hints: [{ receivingSlot: 2, receivingName: 'Player', findingSlot: 2, findingName: 'Player', item: 'Test Item', location: 'Test Location', found: false }],
    });
    const trackedStatus = await (await fetch(`${base}/status`)).json();
    expect(trackedStatus.trackerCapabilities.multitracker).toBe(true);
    expect(trackedStatus.progress).toMatchObject({ checksSeen: 7, checksTotal: 12, itemsSeen: 4, completedPlayers: 1, totalsAvailable: true });
    expect(trackedStatus.slots[0]).toMatchObject({ slot: 2, checksSeen: 7, checksTotal: 12, itemsSeen: 4, status: 'Finished' });
    expect(await (await fetch(`${base}/slots/2/files`)).json()).toHaveLength(1);
    expect(trackedStatus.hints[0].message).toContain('Test Item for Player');
    expect(Date.parse(activeStatus.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(status.lastActivityAt));
    const downloaded = Buffer.from(await (await fetch(`${base}/files/file_test_123`)).arrayBuffer());
    const manifest = JSON.parse(Buffer.from(unzipSync(downloaded)['archipelago.json']).toString('utf8'));
    expect(manifest.server).toBe('example.test:38281');
    expect(await readFile(source)).toEqual(original);
  });
});
