export type View = 'build' | 'library' | 'roster' | 'history' | 'rooms' | 'server' | 'apworlds' | 'tools' | 'settings';

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
  roomsRoot: string;
  popTrackerPath: string;
  emoTrackerPath: string;
  libraryPath: string;
  outputRoot: string;
  launchUrl: string;
  generatorArgs: string;
  roomGatewayMode: 'local' | 'managed' | 'external' | 'direct';
  roomGatewayHostname: string;
  roomGatewayEmail: string;
  roomGatewayPublicUrl: string;
  roomHostApiRemote: boolean;
  allowSpoilerApi: boolean;
  roomHostApiKeyRef?: string;
  roomHostApiKeySet: boolean;
};

export type RoomFile = {
  id: string;
  name: string;
  path: string;
  kind: 'downloaded' | 'imported' | 'prepared' | 'generated';
  size: number;
  modifiedAt: string;
  sourceFileId?: string;
};

export type ManagedRoomSlot = {
  slot: number;
  name: string;
  game: string;
  mine: boolean;
  downloadAvailable: boolean;
  files: RoomFile[];
  remoteFiles?: RoomRemoteFile[];
};

export type RoomRemoteFile = {
  id: string;
  sourceId: string;
  revision: string;
  name: string;
  size: number;
  kind: RoomFile['kind'];
  downloadedFileId?: string;
};

export type RoomProviderCapabilities = {
  apiVersion: number;
  progress: boolean;
  hints: boolean;
  activity: boolean;
  spheres: boolean;
  multipleFiles: boolean;
  browserTrackers: boolean;
  logicAnalysis: boolean;
  remoteWake: boolean;
};

export type RoomActivityEvent = {
  id: string;
  timestamp: string;
  type: string;
  message: string;
  slot?: number;
};

export type RoomSphereCheck = {
  sphere: number;
  finderSlot: number;
  finderName: string;
  finderGame: string;
  receiverSlot: number;
  receiverName: string;
  receiverGame: string;
  itemId: number;
  item: string;
  locationId: number;
  location: string;
};

export type RoomSphereSnapshot = {
  refreshedAt: string;
  available: boolean;
  reason?: 'old-seed' | 'absent' | 'malformed' | 'incompatible' | 'not-running';
  checks: RoomSphereCheck[];
};

export type RoomTrackerPlayer = {
  slot: number;
  name: string;
  alias?: string;
  game: string;
  checksDone: number;
  checksTotal: number;
  itemsReceived: number;
  status: number;
  statusLabel: string;
  lastActivity?: string;
  lastConnection?: string;
  hintCount: number;
  unresolvedHintCount: number;
};

export type RoomTrackerHint = {
  receivingSlot: number;
  receivingName: string;
  findingSlot: number;
  findingName: string;
  itemId: number;
  item: string;
  locationId: number;
  location: string;
  found: boolean;
  entrance: string;
  flags: number;
  status: number;
  classification: 'Progression' | 'Useful' | 'Trap' | 'Filler';
  statusLabel: string;
};

export type RoomTrackerDashboard = {
  refreshedAt: string;
  players: RoomTrackerPlayer[];
  hints: RoomTrackerHint[];
  checksDone: number;
  checksTotal: number;
  completedPlayers: number;
  unresolvedHints: number;
};

export type RoomLogicAnalysis = {
  inLogic: number;
  glitched: number;
  available: number;
  locations: string[];
  analyzedAt: string;
  templateUsed: boolean;
  fingerprint?: string;
  stateFingerprint?: string;
  yamlFingerprint?: string;
  environmentFingerprint?: string;
  stale?: boolean;
  error?: string;
};

export type RoomOriginalState = {
  lifecycle: string;
  endpoint?: RoomEndpoint;
  passwordRequired: boolean;
  slots: Array<{ slot: number; name: string; game: string; connected: boolean; files: RoomRemoteFile[] }>;
  observedAt: string;
  sourceRevision: string;
};

export type RoomEnrichedState = {
  dashboard: RoomTrackerDashboard;
  activity: RoomActivityEvent[];
  spheres: RoomSphereSnapshot;
  logic: Record<string, RoomLogicAnalysis>;
  capabilities: RoomProviderCapabilities;
};

export type ControllerRoomSnapshot = {
  apiVersion: 2;
  schemaVersion: string;
  roomId: string;
  label: string;
  generationId?: string;
  refreshedAt: string;
  stale: boolean;
  original: RoomOriginalState;
  enriched: RoomEnrichedState;
};

export type RoomWakeStatus = 'disabled' | 'starting' | 'online' | 'busy' | 'failed' | 'host unavailable';
export type RoomApiAccessSettings = { remoteEnabled: boolean; allowSpoilers: boolean; apiKeySet: boolean };
export type RoomApiExport = { snapshot: ControllerRoomSnapshot; diagnostics?: Record<string, unknown>; source?: Record<string, unknown> };

export type RoomStatusSnapshot = {
  trackerId?: string;
  lastPort?: number;
  endpoint?: RoomEndpoint;
  lastActivity?: string;
  timeout?: number;
  refreshedAt: string;
  stale: boolean;
  error?: string;
  capabilities?: RoomProviderCapabilities;
  limitedHost?: boolean;
  snapshot?: ControllerRoomSnapshot;
  passwordRequired?: boolean;
};

export type RoomProviderType = 'official' | 'local' | 'controller';

export type RoomProviderDescriptor = {
  type: RoomProviderType;
  roomUrl?: string;
  historyRunId?: string;
  apiVersion?: number;
  capabilities?: RoomProviderCapabilities;
};

export type RoomEndpoint = {
  host: string;
  port: number;
  secure: boolean;
};

export type RoomShareState = 'offline' | 'starting' | 'online' | 'stopping' | 'sharing' | 'error';

export type RoomShareStatus = {
  state: RoomShareState;
  serverRunning: boolean;
  portalRunning: boolean;
  mapping: 'disabled' | 'starting' | 'mapped' | 'failed' | 'unknown';
  reachability: 'local' | 'observed' | 'unknown';
  publicUrl?: string;
  error?: string;
  gateway?: 'disabled' | 'starting' | 'online' | 'error';
  certificate?: 'unused' | 'obtaining' | 'ready' | 'error';
  firewall?: 'unused' | 'checking' | 'ready' | 'error';
  gatewayError?: string;
  secureGameEndpoint?: string;
  compatibilityGameEndpoint?: string;
};

export type RoomGatewayConfig = {
  mode: Settings['roomGatewayMode'];
  hostname: string;
  email: string;
  publicBaseUrl: string;
};

export type HostedRoomConfig = {
  historyRunId: string;
  sessionPath: string;
  artifactPath?: string;
  savePath?: string | null;
  advertisedHost: string;
  gamePort: number;
  portalPort: number;
  publicBaseUrl: string;
  automaticPortMapping: boolean;
  insecureHttpAccepted: boolean;
  sharedSlots: number[];
  shareStatus: RoomShareStatus;
  allowRemoteWake?: boolean;
};

export type RoomInvite = {
  roomId: string;
  browserUrl: string;
  controllerUrl: string;
};

export type SharedRoomFile = {
  id: string;
  slot: number;
  name: string;
  size: number;
  kind: RoomFile['kind'];
};

export type RoomLaunchCapability = {
  displayName?: string;
  gameName?: string;
  supportsUri: boolean;
  mode: 'uri' | 'patch-only' | 'file-only';
};

export type PopTrackerVariant = { id: string; name: string; supportsAp: boolean };
export type PopTrackerPack = {
  uid: string;
  gameName: string;
  name: string;
  version: string;
  filePath: string;
  variants: PopTrackerVariant[];
};
export type PopTrackerAssociation = { packUid: string; variant: string };

export type GameLaunchAction = {
  type: 'steam' | 'program' | 'url' | 'file' | 'minecraft';
  steamMode?: 'app' | 'game' | 'source';
  appId?: string;
  sourceModPath?: string;
  path?: string;
  target?: string;
  arguments?: string;
  workingDirectory?: string;
  launcherPath?: string;
  minecraftRoot?: string;
  minecraftProfileId?: string;
  minecraftProfileName?: string;
  minecraftVersion?: string;
};

export type MinecraftLauncherInventory = {
  launcherPath: string;
  minecraftRoot: string;
  profilePath?: string;
  profiles: Array<{ id: string; name: string; version: string; gameDirectory: string; lastUsed: string; neoForge: boolean }>;
  error?: string;
};

export type GameLaunchProfile = {
  id: string;
  game: string;
  label: string;
  primary: GameLaunchAction;
  companion?: GameLaunchAction;
  companionMode?: 'automatic' | 'manual';
  companionLabel?: string;
  updatedAt: string;
};

export type ManagedRoom = {
  id: string;
  label: string;
  url: string;
  folderPath: string;
  createdAt: string;
  passwordRef?: string;
  passwordSet: boolean;
  passwordRequired?: boolean;
  autoLoginWarningAccepted: boolean;
  slots: ManagedRoomSlot[];
  status: RoomStatusSnapshot;
  provider?: RoomProviderDescriptor;
  hosted?: HostedRoomConfig;
  logicAnalyses?: Record<number, RoomLogicAnalysis>;
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
  roomId?: string;
  roomSlot?: number;
  roomUrl?: string;
  roomProvider?: RoomProviderDescriptor;
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
  rooms: ManagedRoom[];
  popTrackerAssociations: Record<string, PopTrackerAssociation>;
  gameLaunchProfiles: Record<string, GameLaunchProfile>;
  slotLockControllers: SlotLockControllerConfig[];
  settings: Settings;
  host: HostSettings;
  sessionName: string;
  sessionNotes: string;
};
