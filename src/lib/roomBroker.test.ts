/// <reference types="node" />
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { openApi, sanitizeRoom } = require('../../electron/room-broker.cjs') as {
  openApi: (port?: number) => string;
  sanitizeRoom: (room: Record<string, unknown>) => Record<string, any>;
};

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('room broker contract', () => {
  it('defaults saved rooms to visible and strips local file paths', () => {
    const room = sanitizeRoom({
      id: 'room-one', label: 'Room One', url: 'https://archipelago.gg/room/abcdef',
      provider: { type: 'official', roomUrl: 'https://archipelago.gg/room/abcdef' },
      slots: [{ slot: 1, name: 'Player', game: 'Game', files: [{ id: 'file', name: 'patch.apgame', path: 'C:\\secret\\patch.apgame', size: 12, kind: 'downloaded' }] }],
    });
    expect(room.apiVisible).toBe(true);
    expect(room.slots[0].files[0]).not.toHaveProperty('path');
    expect(JSON.stringify(room)).not.toContain('C:\\secret');
  });

  it('preserves an explicit API opt-out', () => {
    expect(sanitizeRoom({ id: 'hidden-room', apiVisible: false }).apiVisible).toBe(false);
  });

  it('publishes the provider-neutral routes at the configured port', () => {
    const contract = openApi(41234);
    expect(contract).toContain('http://127.0.0.1:41234/api/controller/v2');
    expect(contract).toContain('/rooms/{roomId}/snapshot:');
    expect(contract).toContain('/rooms/{roomId}/actions/wake:');
  });

  it('serves cached provider-neutral snapshots and protects actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'controller-broker-test-'));
    const port = await unusedPort();
    let wakes = 0;
    const { createRoomBroker } = require('../../electron/room-broker.cjs') as { createRoomBroker: (options: Record<string, unknown>) => any };
    const broker = createRoomBroker({
      app: { getPath: () => root }, getSecret: async () => 'test-key',
      wakeRoom: async () => { wakes += 1; return { status: 'starting' }; },
      resolveRoom: async (room: Record<string, any>) => ({
        status: { refreshedAt: new Date().toISOString(), stale: false },
        snapshot: {
          apiVersion: 2, schemaVersion: '2.1.0', roomId: room.id, label: room.label,
          refreshedAt: new Date().toISOString(), stale: false,
          original: { lifecycle: 'Offline', passwordRequired: false, slots: [], observedAt: new Date().toISOString(), sourceRevision: 'revision' },
          enriched: {
            dashboard: { refreshedAt: new Date().toISOString(), players: [], hints: [], checksDone: 0, checksTotal: 0, completedPlayers: 0, unresolvedHints: 0 },
            hints: [], activity: [], spheres: { refreshedAt: new Date().toISOString(), available: false, reason: 'absent', checks: [] }, logic: {},
            capabilities: { apiVersion: 2, progress: true, hints: true, activity: true, spheres: false, multipleFiles: false, browserTrackers: false, logicAnalysis: false, remoteWake: true },
          },
        },
      }),
    });
    try {
      await broker.sync({ rooms: [{ id: 'saved-room', label: 'Saved Room', provider: { type: 'local' }, slots: [] }], settings: { enabled: true, port, remoteEnabled: false, allowedOrigins: [], secretRef: 'key' } });
      const list = await fetch(`http://127.0.0.1:${port}/api/controller/v2/rooms`);
      expect(list.status).toBe(200);
      expect((await list.json()).rooms[0].id).toBe('saved-room');
      const first = await fetch(`http://127.0.0.1:${port}/api/controller/v2/rooms/saved-room/snapshot`);
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag')!;
      const unchanged = await fetch(`http://127.0.0.1:${port}/api/controller/v2/rooms/saved-room/snapshot`, { headers: { 'if-none-match': etag } });
      expect(unchanged.status).toBe(304);
      expect((await fetch(`http://127.0.0.1:${port}/api/controller/v2/rooms/saved-room/actions/wake`, { method: 'POST' })).status).toBe(401);
      const wake = await fetch(`http://127.0.0.1:${port}/api/controller/v2/rooms/saved-room/actions/wake`, { method: 'POST', headers: { authorization: 'Bearer test-key' } });
      expect(wake.status).toBe(200);
      expect(wakes).toBe(1);
    } finally {
      await broker.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
