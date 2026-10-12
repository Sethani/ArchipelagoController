export type View = 'build' | 'library' | 'roster' | 'history' | 'server' | 'apworlds' | 'tools' | 'settings';

export type ArchipelagoUpdateStatus = {
  state: 'current' | 'outdated' | 'ahead' | 'unknown';
  installedVersion?: string;
  latestVersion?: string;
  releaseUrl: string;
  installerUrl?: string;
  installerName?: string;
  publishedAt?: string;
  checkedAt?: string;
  stale?: boolean;
  error?: string;
};

export type ApWorldInstallationStatus = 'Current' | 'Update available' | 'Ahead' | 'Unknown version' | 'Unmanaged';
export type ApWorldCompatibilityStatus = 'Compatible' | 'Too old' | 'Too new' | 'Unknown';
export type ApWorldCommunityStatus = 'Stable' | 'Unstable' | 'Broken on Main' | 'Unknown';
export type ApWorldReleaseChannel = 'Release' | 'Prerelease' | 'Unready';

export type ApWorldRelease = {
  id: string;
  version: string;
  tagVersion: string;
  url: string;
  releaseUrl: string;
  size: number;
  sha256: string;
  createdAt?: string;
  minimumApVersion?: string;
  maximumApVersion?: string;
  channel: ApWorldReleaseChannel;
  flags: string[];
};

export type ApWorldCatalogEntry = {
  id: string;
  game: string;
  description: string;
  authors: string[];
  sourceUrl?: string;
  trackerUrl?: string;
  license?: string;
  disclosure?: string;
  communityStatus: ApWorldCommunityStatus;
  prStatus?: string;
  communityNotes?: string;
  adult: boolean;
  releases: ApWorldRelease[];
};

export type ApWorldInventoryEntry = {
  id: string;
  game: string;
  path: string;
  fileName: string;
  version?: string;
  minimumApVersion?: string;
  maximumApVersion?: string;
  authors: string[];
  sourceUrl?: string;
  trackerUrl?: string;
  license?: string;
  disclosure?: string;
  sha256: string;
  matchedReleaseId?: string;
  legacyGame?: string;
  issues: string[];
};

export type BuiltInApWorld = {
  id: string;
  game: string;
  version?: string;
  authors: string[];
};

export type ApWorldMatchStatus = 'Installed' | 'Installed with override' | 'Installed but incompatible' | 'Possible legacy match' | 'Missing' | 'Ambiguous';
export type ApWorldGameCandidate = {
  id: string;
  game: string;
  source: 'custom' | 'custom-legacy' | 'built-in' | 'legacy-template';
  version?: string;
  signature: string;
  compatibility: ApWorldCompatibilityStatus;
};
export type ApWorldMatchResult = {
  game: string;
  status: ApWorldMatchStatus;
  signature: string;
  candidates: ApWorldGameCandidate[];
  suggestion?: string;
  message: string;
};

export type ApYamlValidationStatus = 'Not checked' | 'Valid' | 'Context required' | 'Rejected' | 'Generator failed' | 'Timed out' | 'Cancelled';
export type ApYamlValidationResult = {
  status: Exclude<ApYamlValidationStatus, 'Not checked'>;
  checkedAt: string;
  fingerprint: string;
  worldSignature: string;
  contextFingerprint?: string;
  message: string;
  output: string;
  durationMs: number;
};
export type ApYamlValidationProgress = {
  jobId: string;
  templateId?: string;
  index: number;
  total: number;
  state: 'started' | 'checking' | 'complete' | 'cancelled';
  result?: ApYamlValidationResult;
};

export type ApWorldSourceStatus = {
  source: 'index' | 'spreadsheet';
  ok: boolean;
  updatedAt?: string;
  error?: string;
};

export type ApWorldCatalogResult = {
  entries: ApWorldCatalogEntry[];
  sources: ApWorldSourceStatus[];
  updatedAt?: string;
  stale: boolean;
};

export type Template = {
  id: string;
  fileName: string;
  path: string;
  sourcePath?: string;
  content: string;
  game: string;
  description: string;
  slotName: string;
  importedAt: string;
  lastUsed?: string;
  errors: string[];
  playerId?: string;
  derivedFromId?: string;
  worldMatch?: ApWorldMatchResult;
  apValidation?: ApYamlValidationResult;
};

export type Player = {
  id: string;
  name: string;
  preferredSlot: string;
  note: string;
};

export type SlotLockOptions = {
  randomUnlockedSlots: number;
  freeStartingItems: boolean;
  unlockItemCopies: number;
  unlockItemFiller: number;
  freeUnlockedWorldItems: number;
  bonusItemSlots: number;
  bonusItemCopies: number;
  bonusItemFiller: number;
  autoHintLockedItems: boolean;
};

export type SlotLockControllerConfig = {
  playerId: string;
  enabled: boolean;
  sourceTemplateId?: string;
  slotName: string;
  excludedTemplateIds: string[];
  options: SlotLockOptions;
  apValidation?: ApYamlValidationResult;
};

export type Settings = {
  installRoot: string;
  importSource: string;
  hostedSessionsPath: string;
  popTrackerPath: string;
  emoTrackerPath: string;
  libraryPath: string;
  outputRoot: string;
  launchUrl: string;
  generatorArgs: string;
};

export type HostSettings = {
  host: string;
  port: number;
  roomPasswordRef?: string;
  roomPasswordSet: boolean;
  serverPasswordRef?: string;
  serverPasswordSet: boolean;
  savefile: string;
  autoShutdown: number;
  logLevel: string;
  raw: string;
  document: Record<string, unknown>;
  comments: Record<string, string>;
};

export type RemoteProfile = {
  id: string;
  label: string;
  address: string;
  slotName: string;
  roomPasswordRef?: string;
  roomPasswordSet: boolean;
  serverPasswordRef?: string;
  serverPasswordSet: boolean;
  historyRunId?: string;
  lastConnectedAt?: string;
};

export type ConsoleTarget = 'none' | 'local' | 'remote';
export type ConsoleConnectionState = 'disconnected' | 'connecting' | 'chat' | 'admin';
export type ConsoleEvent = {
  target: Exclude<ConsoleTarget, 'none'>;
  level: 'info' | 'message' | 'command' | 'error';
  text: string;
  timestamp: string;
};

export type HistoryRun = {
  id: string;
  name: string;
  createdAt: string;
  templateIds: string[];
  playerCount: number;
  slotCount?: number;
  games: string[];
  slots?: Array<{ game: string; name: string; originalName?: string }>;
  outputPath: string;
  artifactPath?: string;
  savePath?: string | null;
  seed?: string | null;
  status: 'ready' | 'failed' | 'generated';
  notes: string;
  host: HostSettings;
  logs: string[];
  slotLockControllers: SlotLockControllerConfig[];
};

export type SessionPreset = {
  id: string;
  name: string;
  templateIds: string[];
  notes: string;
  host: HostSettings;
  slotLockControllers: SlotLockControllerConfig[];
};

export type AppState = {
  templates: Template[];
  selectedIds: string[];
  players: Player[];
  history: HistoryRun[];
  presets: SessionPreset[];
  remoteProfiles: RemoteProfile[];
  slotLockControllers: SlotLockControllerConfig[];
  settings: Settings;
  host: HostSettings;
  sessionName: string;
  sessionNotes: string;
};
