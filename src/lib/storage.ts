import type { AppState, ManagedRoomSlot } from '../types';
import { normalizeLegacySlotName, yamlFingerprint } from './session';
import { migrateMainRelativeSettings } from './paths';
import { defaultSlotLockOptions } from './slotlock';

const KEY = 'archipelago-controller-state-v1';

function withoutLegacyAccessToken<T extends object>(value: T): T {
  const migrated = { ...value } as T & { accessTokenRef?: unknown; accessTokenSet?: unknown };
  delete migrated.accessTokenRef;
  delete migrated.accessTokenSet;
  return migrated;
}

function deduplicateRoomSlots(slots: ManagedRoomSlot[]): ManagedRoomSlot[] {
  const result: ManagedRoomSlot[] = [];
  const indexes = new Map<string, number>();
  for (const slot of slots) {
    const keys = [`slot:${Number(slot.slot)}`, `name:${String(slot.name).trim().toLocaleLowerCase()}`];
    const existingIndex = keys.map((key) => indexes.get(key)).find((index) => index !== undefined);
    if (existingIndex !== undefined) {
      const existing = result[existingIndex];
      result[existingIndex] = {
        ...existing,
        mine: existing.mine || slot.mine,
        downloadAvailable: existing.downloadAvailable || slot.downloadAvailable,
        files: [...new Map([...existing.files, ...slot.files].map((file) => [file.id || file.path || file.name, file])).values()],
        remoteFiles: [...new Map([...(existing.remoteFiles ?? []), ...(slot.remoteFiles ?? [])].map((file) => [file.id || file.sourceId || file.name, file])).values()],
      };
      for (const key of keys) indexes.set(key, existingIndex);
      continue;
    }
    const index = result.length;
    result.push(slot);
    for (const key of keys) indexes.set(key, index);
  }
  return result;
}

export const initialState: AppState = {
  templates: [],
  selectedIds: [],
  players: [],
  history: [],
  presets: [],
  rooms: [],
  popTrackerAssociations: {},
  gameLaunchProfiles: {},
  slotLockControllers: [],
  settings: {
    installRoot: 'C:\\ProgramData\\Archipelago',
    importSource: '{main}\\Players\\Temp',
    hostedSessionsPath: 'C:\\games\\archipelago',
    roomsRoot: '{hosted}\\Rooms',
    popTrackerPath: '',
    emoTrackerPath: '',
    libraryPath: '{main}\\Players\\ControllerLibrary',
    outputRoot: '{main}\\output',
    launchUrl: 'https://archipelago.gg/uploads',
    generatorArgs: '--player_files_path "{input}" --outputpath "{output}"',
    roomGatewayMode: 'local',
    roomGatewayHostname: '',
    roomGatewayEmail: '',
    roomGatewayPublicUrl: '',
    roomDataApiEnabled: true,
    roomDataApiPort: 38283,
    roomDataApiRemote: false,
    roomDataApiAllowedOrigins: '',
    allowSpoilerApi: false,
    roomHostApiKeySet: false,
  },
  host: {
    host: '',
    port: 38281,
    roomPasswordSet: false,
    serverPasswordSet: false,
    savefile: '',
    autoShutdown: 0,
    logLevel: 'info',
    raw: 'release_mode: auto\ncollect_mode: auto\nremaining_mode: goal\ncountdown_mode: auto\ncompatibility: 2',
    document: {},
    comments: {},
  },
  sessionName: 'Game Night',
  sessionNotes: '',
  remoteProfiles: [],
};

export function loadState(): AppState {
  try {
    const saved = localStorage.getItem(KEY);
    if (!saved) return initialState;
    const parsed = JSON.parse(saved) as Partial<AppState>;
    const savedSettings = parsed.settings ?? initialState.settings;
    const { roomHostApiRemote: legacyRoomApiRemote, ...safeSavedSettings } = savedSettings;
    const normalizedTemplates = (parsed.templates ?? []).map((template) => ({
      ...template,
      slotName: normalizeLegacySlotName(template.fileName, template.path, template.slotName),
    }));
    const canonicalByContent = new Map<string, string>();
    const duplicateIds = new Map<string, string>();
    const templates = normalizedTemplates.filter((template) => {
      if (template.derivedFromId) return true;
      const fingerprint = yamlFingerprint(template.content);
      const canonicalId = canonicalByContent.get(fingerprint);
      if (canonicalId) {
        duplicateIds.set(template.id, canonicalId);
        return false;
      }
      canonicalByContent.set(fingerprint, template.id);
      return true;
    });
    const selectedIds = [...new Set((parsed.selectedIds ?? []).map((id) => duplicateIds.get(id) ?? id))]
      .filter((id) => templates.some((template) => template.id === id));
    const parsedHost = (parsed.host ?? {}) as AppState['host'] & { password?: string };
    const { password: _legacyPassword, ...safeHost } = parsedHost;
    const normalizedHost = ['0.0.0.0', '::', '[::]'].includes((safeHost.host ?? '').trim()) ? '' : safeHost.host;
    return {
      ...initialState,
      ...parsed,
      templates,
      selectedIds,
      settings: migrateMainRelativeSettings({
        ...initialState.settings,
        ...safeSavedSettings,
        roomDataApiEnabled: savedSettings.roomDataApiEnabled ?? true,
        roomDataApiPort: Number(savedSettings.roomDataApiPort) || 38283,
        roomDataApiRemote: savedSettings.roomDataApiRemote ?? legacyRoomApiRemote ?? false,
        roomDataApiAllowedOrigins: savedSettings.roomDataApiAllowedOrigins || '',
        popTrackerPath: savedSettings.popTrackerPath || '',
        emoTrackerPath: savedSettings.emoTrackerPath || '',
        libraryPath: savedSettings.libraryPath || initialState.settings.libraryPath,
        outputRoot: savedSettings.outputRoot || initialState.settings.outputRoot,
      }),
      host: {
        ...initialState.host,
        ...safeHost,
        document: safeHost.document && typeof safeHost.document === 'object' ? safeHost.document : {},
        comments: safeHost.comments && typeof safeHost.comments === 'object' ? safeHost.comments : {},
        host: normalizedHost,
        roomPasswordSet: Boolean(parsedHost.roomPasswordSet || parsedHost.password),
      },
      remoteProfiles: parsed.remoteProfiles ?? [],
      rooms: (parsed.rooms ?? []).map((room) => ({
        ...room,
        apiVisible: room.apiVisible !== false,
        provider: room.provider ? withoutLegacyAccessToken(room.provider) : { type: 'official', roomUrl: room.url },
        passwordSet: Boolean(room.passwordSet),
        passwordRequired: Boolean(room.passwordRequired ?? room.status?.passwordRequired),
        autoLoginWarningAccepted: Boolean(room.autoLoginWarningAccepted),
        logicAnalyses: room.logicAnalyses ?? {},
        slots: deduplicateRoomSlots((room.slots ?? []).map((slot) => ({ ...slot, mine: Boolean(slot.mine), files: slot.files ?? [], remoteFiles: slot.remoteFiles ?? [] }))),
        status: { ...room.status, stale: room.status?.stale ?? true },
        hosted: room.hosted ? {
          ...withoutLegacyAccessToken(room.hosted),
          publicBaseUrl: room.hosted.publicBaseUrl ?? '',
          advertisedHost: room.hosted.advertisedHost ?? '',
          automaticPortMapping: room.hosted.automaticPortMapping ?? true,
          insecureHttpAccepted: Boolean(room.hosted.insecureHttpAccepted),
          sharedSlots: room.hosted.sharedSlots ?? [],
          allowRemoteWake: Boolean(room.hosted.allowRemoteWake),
          shareStatus: { state: 'offline', serverRunning: false, portalRunning: false, mapping: 'unknown', reachability: 'unknown' },
        } : undefined,
      })),
      popTrackerAssociations: parsed.popTrackerAssociations ?? {},
      gameLaunchProfiles: Object.fromEntries(Object.entries(parsed.gameLaunchProfiles ?? {}).map(([key, profile]) => {
        const witness = profile.game.trim().toLocaleLowerCase() === 'the witness';
        return [key, {
          ...profile,
          companionMode: profile.companion ? profile.companionMode ?? (witness ? 'manual' : 'automatic') : undefined,
          companionLabel: profile.companion ? profile.companionLabel ?? (witness ? 'Run randomizer' : undefined) : undefined,
        }];
      })),
      slotLockControllers: (parsed.slotLockControllers ?? []).map((config) => ({
        ...config,
        excludedTemplateIds: config.excludedTemplateIds ?? [],
        options: { ...defaultSlotLockOptions, ...config.options },
      })),
      presets: (parsed.presets ?? []).map((preset) => ({ ...preset, slotLockControllers: preset.slotLockControllers ?? [] })),
      history: (parsed.history ?? []).map((run) => ({ ...run, slotLockControllers: run.slotLockControllers ?? [] })),
    };
  } catch {
    return initialState;
  }
}

export function loadLegacyHostPassword(): string {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { host?: { password?: string } };
    return parsed.host?.password ?? '';
  } catch {
    return '';
  }
}

export function saveState(state: AppState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}
