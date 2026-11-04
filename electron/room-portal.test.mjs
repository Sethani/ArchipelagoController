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
    const portal = createRoomPortal({ patchArchive, onWake: async () => ({ status: 'starting' }) });
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
    const portal = createRoomPortal({ patchArchive, onWake: async () => ({ status: 'starting' }) });
    portals.push(portal);
    const result = await portal.start({
      roomId: 'room-test-123', label: 'Test Room', generationId: 'seed-1', portalPort: 0,
      automaticPortMapping: false, serverRunning: true, passwordRequired: true, createdAt: '2026-10-20T08:00:00.000Z',
      allowRemoteWake: true, wakeNonce: 'test-wake-nonce', hostApiKey: 'test-host-api-key',
      sourceMetadata: { artifactSha256: 'abc123', seedName: 'Test Seed', slotCount: 1, games: ['Test Game'], raceMode: false },
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
    expect(roomPage).toContain('/api/controller/v2/room/');
    expect(roomPage).not.toContain('/api/controller/v1/room/');
    const status = await (await fetch(`${base}/status`)).json();
    expect(status).toMatchObject({ apiVersion: 1, provider: 'controller', label: 'Test Room', state: 'Online', passwordRequired: true, createdAt: '2026-10-20T08:00:00.000Z', endpoint: { host: 'example.test', port: 38281 }, progress: { checksSeen: 0, itemsSeen: 0, totalsAvailable: false } });
    expect(status.startedAt).toBeTruthy();
    const v2base = `http://127.0.0.1:${result.portalPort}/api/controller/v2/room/room-test-123`;
    const snapshotResponse = await fetch(`${v2base}/snapshot`);
    expect(snapshotResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(snapshotResponse.headers.get('etag')).toBeTruthy();
    const snapshot = await snapshotResponse.json();
    expect(snapshot).toMatchObject({ apiVersion: 2, schemaVersion: '2.0.0', original: { lifecycle: 'Online' }, enriched: { capabilities: { progress: true, multipleFiles: true, remoteWake: true } } });
    expect(JSON.stringify(snapshot)).not.toContain(source);
    expect((await fetch(`${v2base}/snapshot`, { headers: { 'if-none-match': snapshotResponse.headers.get('etag') } })).status).toBe(304);
    const schema = await (await fetch(`http://127.0.0.1:${result.portalPort}/api/controller/v2/schema`)).json();
    expect(schema).toMatchObject({ $schema: expect.stringContaining('json-schema'), apiVersion: 2, properties: { original: expect.any(Object), enriched: expect.any(Object) } });
    expect(await (await fetch(`${v2base}/actions/wake`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-controller-wake': 'test-wake-nonce' }, body: '{}' })).json()).toMatchObject({ status: 'starting' });
    expect((await fetch(`http://127.0.0.1:${result.portalPort}/api/controller/v2/host/room/room-test-123/export`)).status).toBe(401);
    const exportResponse = await fetch(`http://127.0.0.1:${result.portalPort}/api/controller/v2/host/room/room-test-123/export`, { headers: { authorization: 'Bearer test-host-api-key' } });
    expect(exportResponse.status).toBe(200);
    const hostExport = await exportResponse.json();
    expect(hostExport).toMatchObject({ source: { seedName: 'Test Seed', artifactSha256: 'abc123' }, protocol: { endpoint: { host: 'example.test' } }, tracker: expect.any(Object), logic: {} });
    expect(JSON.stringify(hostExport)).not.toContain(source);
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
