import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, loadState } from './storage';

describe('stored host settings', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  it.each(['0.0.0.0', '::', '[::]'])('migrates wildcard bind address %s to the AP default', (host) => {
    localStorage.setItem('archipelago-controller-state-v1', JSON.stringify({
      ...initialState,
      host: { ...initialState.host, host },
    }));

    expect(loadState().host.host).toBe('');
  });

  it('migrates saved installation child folders to main tokens', () => {
    localStorage.setItem('archipelago-controller-state-v1', JSON.stringify({
      ...initialState,
      settings: {
        ...initialState.settings,
        installRoot: 'D:\\Archipelago',
        importSource: 'D:\\Archipelago\\Players\\Temp',
        libraryPath: 'D:\\Archipelago\\Players\\ControllerLibrary',
        outputRoot: 'D:\\Archipelago\\output',
        hostedSessionsPath: 'C:\\games\\archipelago',
      },
    }));

    const settings = loadState().settings;
    expect(settings.importSource).toBe('{main}\\Players\\Temp');
    expect(settings.libraryPath).toBe('{main}\\Players\\ControllerLibrary');
    expect(settings.outputRoot).toBe('{main}\\output');
    expect(settings.hostedSessionsPath).toBe('C:\\games\\archipelago');
  });

  it('removes legacy room access-token metadata', () => {
    localStorage.setItem('archipelago-controller-state-v1', JSON.stringify({
      ...initialState,
      rooms: [{
        id: 'local-test-room', label: 'Test room', url: 'local://room/local-test-room', folderPath: 'C:\\Rooms\\Test',
        createdAt: '2026-10-20T00:00:00.000Z', passwordSet: false, autoLoginWarningAccepted: false,
        provider: { type: 'local', historyRunId: 'run-1', accessTokenRef: 'legacy-guest-token' },
        slots: [], status: { refreshedAt: '2026-10-20T00:00:00.000Z', stale: true },
        hosted: {
          historyRunId: 'run-1', sessionPath: 'C:\\Sessions\\Test', advertisedHost: 'rooms.example.test',
          gamePort: 38281, portalPort: 38282, publicBaseUrl: '', automaticPortMapping: false,
          insecureHttpAccepted: false, sharedSlots: [], accessTokenRef: 'legacy-host-token', accessTokenSet: true,
          shareStatus: { state: 'offline', serverRunning: false, portalRunning: false, mapping: 'unknown', reachability: 'unknown' },
        },
      }],
    }));

    const room = loadState().rooms[0];
    expect('accessTokenRef' in room.provider!).toBe(false);
    expect('accessTokenRef' in room.hosted!).toBe(false);
    expect('accessTokenSet' in room.hosted!).toBe(false);
  });

  it('keeps guest-local room logic analyses across restarts', () => {
    localStorage.setItem('archipelago-controller-state-v1', JSON.stringify({
      ...initialState,
      rooms: [{
        id: 'remote-test-room', label: 'Remote room', url: 'https://rooms.example/room/remote-test-room', folderPath: 'C:\\Rooms\\Remote',
        createdAt: '2026-11-04T00:00:00.000Z', passwordSet: false, autoLoginWarningAccepted: false,
        provider: { type: 'controller', roomUrl: 'https://rooms.example/room/remote-test-room' },
        slots: [{ slot: 2, name: 'Player', game: 'Minecraft', mine: true, downloadAvailable: false, files: [] }],
        status: { refreshedAt: '2026-11-04T00:00:00.000Z', stale: true },
        logicAnalyses: { 2: { inLogic: 10, glitched: 3, available: 13, locations: [], analyzedAt: '2026-11-04T00:00:00.000Z', templateUsed: true, environmentFingerprint: 'environment-1' } },
      }],
    }));

    expect(loadState().rooms[0].logicAnalyses?.[2]).toMatchObject({ inLogic: 10, glitched: 3, environmentFingerprint: 'environment-1' });
  });

  it('repairs duplicate slots in saved rooms without losing files', () => {
    localStorage.setItem('archipelago-controller-state-v1', JSON.stringify({
      ...initialState,
      rooms: [{
        id: 'local-duplicate-room', label: 'Duplicate room', url: 'local://room/local-duplicate-room', folderPath: 'C:\\Rooms\\Duplicate',
        createdAt: '2026-11-04T00:00:00.000Z', passwordSet: false, autoLoginWarningAccepted: false,
        slots: [
          { slot: 1, name: 'Player_MC', game: 'Minecraft', mine: true, downloadAvailable: true, files: [{ id: 'a', name: 'a.apmc', path: 'a', kind: 'downloaded', size: 1, modifiedAt: '2026-11-04T00:00:00.000Z' }] },
          { slot: 1, name: 'Player_MC', game: 'Minecraft', mine: false, downloadAvailable: true, files: [{ id: 'b', name: 'b.apmc', path: 'b', kind: 'downloaded', size: 1, modifiedAt: '2026-11-04T00:00:00.000Z' }] },
        ],
        status: { refreshedAt: '2026-11-04T00:00:00.000Z', stale: true },
      }],
    }));

    expect(loadState().rooms[0].slots).toHaveLength(1);
    expect(loadState().rooms[0].slots[0].files.map((file) => file.id)).toEqual(['a', 'b']);
  });
});
