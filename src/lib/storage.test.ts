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
});
