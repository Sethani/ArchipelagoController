/// <reference types="vite/client" />

type PickedYaml = { path: string; name: string; content: string };
type ProcessResult = { ok: boolean; exitCode?: number; error?: string | null; outputPath?: string };

interface Window {
  archipelago?: {
    pickYamlFiles(): Promise<PickedYaml[]>;
    readYamlDirectory(path: string): Promise<PickedYaml[]>;
    pickDirectory(title: string): Promise<string | null>;
    pickExecutable(title: string): Promise<string | null>;
    pickApWorld(): Promise<string | null>;
    exportYaml(payload: { fileName: string; content: string }): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
    exportYamlPack(payload: { files: Array<{ name: string; content: string }> }): Promise<{ ok: boolean; canceled?: boolean; paths: string[] }>;
    exists(path: string): Promise<boolean>;
    reveal(path: string): Promise<string>;
    openExternal(url: string): Promise<void>;
    inventoryTools(installRoot: string): Promise<{
      programs: Array<{ name: string; path: string }>;
      worlds: Array<{ name: string; path: string }>;
      components: Array<{ displayName: string; type: string; sourceWorld: string; origin: 'custom' | 'built-in' }>;
    }>;
    checkArchipelagoUpdate(payload: { installRoot: string; force?: boolean }): Promise<import('./types').ArchipelagoUpdateStatus>;
    readHostConfig(installRoot: string): Promise<{ ok: boolean; document?: Record<string, unknown>; comments?: Record<string, string>; sourcePath?: string; error?: string }>;
    writeHostConfig(payload: { installRoot: string; document: Record<string, unknown> }): Promise<{ ok: boolean; path?: string; backupPath?: string; error?: string }>;
    inventoryApWorlds(installRoot: string): Promise<{ installed: import('./types').ApWorldInventoryEntry[]; builtIn: import('./types').BuiltInApWorld[]; apVersion?: string; error?: string }>;
    getApWorldCatalog(options?: { maxAgeMs?: number }): Promise<import('./types').ApWorldCatalogResult>;
    refreshApWorldCatalog(): Promise<import('./types').ApWorldCatalogResult>;
    installApWorld(payload: { installRoot: string; worldId: string; releaseId: string }): Promise<{ ok: boolean; error?: string; warning?: string }>;
    importApWorld(payload: { installRoot: string; sourcePath: string }): Promise<{ ok: boolean; error?: string; warning?: string }>;
    removeApWorld(payload: { installRoot: string; worldId: string }): Promise<{ ok: boolean; error?: string }>;
    resolveYamlGames(payload: { installRoot: string; games: string[] }): Promise<import('./types').ApWorldMatchResult[]>;
    validateYamls(payload: { installRoot: string; sessionContext?: boolean; templates: Array<{ id: string; fileName: string; content: string; sourceFingerprint?: string }> }): Promise<{ ok: boolean; jobId?: string; results: Array<{ templateId: string; result: import('./types').ApYamlValidationResult }>; error?: string }>;
    cancelYamlValidation(): Promise<{ ok: boolean; cancelled: boolean }>;
    launchTool(path: string): Promise<{ ok: boolean; error?: string }>;
    launchApWorldComponent(payload: { installRoot: string; displayName: string }): Promise<{ ok: boolean; error?: string }>;
    openPatch(installRoot: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
    saveLibraryFiles(payload: unknown): Promise<string[]>;
    scanExistingHistory(payload: unknown): Promise<Array<{
      importKey: string; name: string; createdAt: string; outputPath: string; artifactPath: string; savePath: string | null;
      seed: string | null; playerCount: number; slotCount: number; games: string[]; slots: Array<{ game: string; name: string }>;
    }>>;
    generate(payload: unknown): Promise<ProcessResult>;
    dryRun(payload: unknown): Promise<ProcessResult>;
    host(payload: unknown): Promise<ProcessResult>;
    hostStatus(): Promise<{ running: boolean; pid: number | null }>;
    sendHostInput(value: string): Promise<{ ok: boolean; error?: string }>;
    stopHost(): Promise<{ ok: boolean; running: boolean }>;
    setSecret(payload: { id: string; value: string }): Promise<{ ok: boolean; configured: boolean }>;
    removeSecret(id: string): Promise<{ ok: boolean; configured: boolean }>;
    connectRemote(profile: import('./types').RemoteProfile): Promise<{ ok: boolean; error?: string }>;
    disconnectRemote(): Promise<{ ok: boolean }>;
    remoteStatus(): Promise<{ state: import('./types').ConsoleConnectionState; profileId?: string }>;
    sendRemoteInput(value: string): Promise<{ ok: boolean; error?: string }>;
    remoteAdminLogin(secretRef: string): Promise<{ ok: boolean; error?: string }>;
    onLog(callback: (value: string) => void): () => void;
    onHostStatus(callback: (value: { running: boolean; pid?: number; exitCode?: number; error?: string }) => void): () => void;
    onConsoleEvent(callback: (value: import('./types').ConsoleEvent) => void): () => void;
    onRemoteStatus(callback: (value: { state: import('./types').ConsoleConnectionState; detail?: string }) => void): () => void;
    onYamlValidationProgress(callback: (value: import('./types').ApYamlValidationProgress) => void): () => void;
  };
}
