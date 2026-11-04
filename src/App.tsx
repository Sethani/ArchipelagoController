import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArrowRightLeft, BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, CircleX, Clipboard,
  Clock3, Copy, Download, ExternalLink, FileCode2, FilePlus2, FolderOpen, Gamepad2, Globe2, History,
  Library, Link, ListChecks, LoaderCircle, Menu, PackageSearch, Play, Plus, RefreshCcw, Rocket, Save, Search,
  LockKeyhole, Send, Server, Settings as SettingsIcon, SlidersHorizontal, Square, TerminalSquare, Trash2, UserRound, UsersRound, WandSparkles, Wrench,
  X,
} from 'lucide-react';
import type { ApWorldMatchResult, ApYamlValidationProgress, ApYamlValidationStatus, AppState, ArchipelagoUpdateStatus, ConsoleConnectionState, ConsoleEvent, HistoryRun, ManagedRoom, Player, RemoteProfile, RoomBrokerState, SessionPreset, SlotLockControllerConfig, Template, View } from './types';
import { compactGameName, contentWithSlotName, exportedYamlName, hostYaml, inspectYaml, prepareTemplates, suggestedFileName, validateRawHostYaml, validationFingerprint, yamlFingerprint } from './lib/session';
import { initialState, loadLegacyHostPassword, loadState, saveState } from './lib/storage';
import { mainRelativeSettings, resolveMainPath, resolveStoragePath, tokenizeMainPath } from './lib/paths';
import { ApWorldsView } from './ApWorldsView';
import { findGameHostSections, GameSettingsDialog, ServerSettingsView } from './ServerSettingsView';
import type { GameSettingsTarget } from './ServerSettingsView';
import { buildSlotLockTargetGroups, createSlotLockConfig, createSlotLockTemplate, hydrateSlotLockOptions } from './lib/slotlock';
import { RoomsView } from './RoomsView';

const navItems: { id: View; label: string; icon: typeof Rocket }[] = [
  { id: 'build', label: 'Session Build', icon: Rocket },
  { id: 'library', label: 'Template Library', icon: Library },
  { id: 'roster', label: 'Player Roster', icon: UsersRound },
  { id: 'history', label: 'History', icon: History },
  { id: 'rooms', label: 'Rooms', icon: Link },
  { id: 'server', label: 'Server Settings', icon: SlidersHorizontal },
  { id: 'apworlds', label: 'APWorlds', icon: PackageSearch },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

const formatDate = (value?: string) => value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Never';
const electronReady = Boolean(window.archipelago);
const installedProgram = (root: string, name: string) => `${root.replace(/[\\/]$/, '')}\\${name}`;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function savedLayoutNumber(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function templateValidationStatus(template: Template, contextFingerprint?: string): ApYamlValidationStatus | 'Stale' {
  if (!template.apValidation) return 'Not checked';
  if (template.apValidation.fingerprint !== validationFingerprint(template.content) || template.apValidation.worldSignature !== template.worldMatch?.signature) return 'Stale';
  if (template.apValidation.contextFingerprint && contextFingerprint && template.apValidation.contextFingerprint !== contextFingerprint) return 'Stale';
  return template.apValidation.status;
}

function assignedPlayer(template: Template, players: Player[]): Player | undefined {
  if (template.playerId) return players.find((player) => player.id === template.playerId);
  const slot = template.slotName.trim().toLowerCase();
  return players.find((player) => [player.preferredSlot, player.name].some((value) => value.trim().toLowerCase() === slot));
}

function playerIdentity(template: Template, players: Player[]): string {
  const player = assignedPlayer(template, players);
  return player ? `roster:${player.id}` : `slot:${template.slotName.trim().toLowerCase()}`;
}

function IconButton({ label, children, onClick, danger = false }: { label: string; children: React.ReactNode; onClick?: () => void; danger?: boolean }) {
  return <button className={`icon-button ${danger ? 'danger' : ''}`} title={label} aria-label={label} onClick={onClick}>{children}</button>;
}

function StatusChip({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'neutral'; children: React.ReactNode }) {
  return <span className={`status-chip ${tone}`}>{children}</span>;
}

function EmptyState({ icon: Icon, title, action, onAction }: { icon: typeof Library; title: string; action: string; onAction: () => void }) {
  return <div className="empty-state"><Icon size={26} /><strong>{title}</strong><button className="secondary-button" onClick={onAction}><Plus size={15} />{action}</button></div>;
}

export function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [view, setView] = useState<View>('build');
  const [search, setSearch] = useState('');
  const [logs, setLogs] = useState<string[]>(['Controller ready. Configure Archipelago paths in Settings.']);
  const [logsOpen, setLogsOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => savedLayoutNumber('archipelago-controller-sidebar-width', 218));
  const [consoleHeight, setConsoleHeight] = useState(() => savedLayoutNumber('archipelago-controller-console-height', 348));
  const [running, setRunning] = useState<'idle' | 'validating' | 'generating' | 'hosting'>('idle');
  const [missingTemplateIds, setMissingTemplateIds] = useState<string[]>([]);
  const [generatorExists, setGeneratorExists] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [hostRunning, setHostRunning] = useState(false);
  const [activeHostRoomId, setActiveHostRoomId] = useState<string>();
  const [consoleEvents, setConsoleEvents] = useState<ConsoleEvent[]>([]);
  const [remoteState, setRemoteState] = useState<ConsoleConnectionState>('disconnected');
  const [validationProgress, setValidationProgress] = useState<ApYamlValidationProgress>();
  const [apWorldQuery, setApWorldQuery] = useState('');
  const [apUpdate, setApUpdate] = useState<ArchipelagoUpdateStatus>();
  const [checkingApUpdate, setCheckingApUpdate] = useState(false);
  const [gameSettingsTarget, setGameSettingsTarget] = useState<GameSettingsTarget>();
  const [slotLockWorldMatch, setSlotLockWorldMatch] = useState<ApWorldMatchResult>();
  const [roomBrokerState, setRoomBrokerState] = useState<RoomBrokerState>();
  const legacyPassword = useRef(loadLegacyHostPassword());
  const viewContentRef = useRef<HTMLDivElement>(null);
  const initialImportStarted = useRef(false);
  const initialHistoryScanStarted = useRef(false);
  const resolvedPaths = useMemo(() => ({
    importSource: resolveMainPath(state.settings.importSource, state.settings.installRoot),
    hostedSessionsPath: resolveMainPath(state.settings.hostedSessionsPath, state.settings.installRoot),
    libraryPath: resolveMainPath(state.settings.libraryPath, state.settings.installRoot),
    outputRoot: resolveMainPath(state.settings.outputRoot, state.settings.installRoot),
    roomsRoot: resolveStoragePath(state.settings.roomsRoot, state.settings.installRoot, state.settings.hostedSessionsPath),
  }), [state.settings.installRoot, state.settings.importSource, state.settings.hostedSessionsPath, state.settings.libraryPath, state.settings.outputRoot, state.settings.roomsRoot]);

  useEffect(() => saveState(state), [state]);
  useEffect(() => {
    if (!window.archipelago?.syncRoomBroker) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void window.archipelago!.syncRoomBroker({
        rooms: state.rooms,
        settings: {
          enabled: state.settings.roomDataApiEnabled,
          port: state.settings.roomDataApiPort,
          remoteEnabled: state.settings.roomDataApiRemote,
          allowedOrigins: state.settings.roomDataApiAllowedOrigins.split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean),
          secretRef: state.settings.roomHostApiKeyRef,
        },
      }).then((result) => { if (active && !('error' in result && result.ok === false)) setRoomBrokerState(result); });
    }, 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [state.rooms, state.settings.roomDataApiEnabled, state.settings.roomDataApiPort, state.settings.roomDataApiRemote, state.settings.roomDataApiAllowedOrigins, state.settings.roomHostApiKeyRef]);
  useEffect(() => localStorage.setItem('archipelago-controller-sidebar-width', String(sidebarWidth)), [sidebarWidth]);
  useEffect(() => localStorage.setItem('archipelago-controller-console-height', String(consoleHeight)), [consoleHeight]);
  useEffect(() => { viewContentRef.current?.scrollTo({ top: 0, left: 0 }); }, [view]);

  const resizeSidebar = (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 1100) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (next: PointerEvent) => setSidebarWidth(clamp(startWidth + next.clientX - startX, 176, Math.min(360, window.innerWidth - 560)));
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); document.body.classList.remove('resizing-layout'); };
    document.body.classList.add('resizing-layout');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };

  const resizeConsole = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = consoleHeight;
    const move = (next: PointerEvent) => setConsoleHeight(clamp(startHeight + startY - next.clientY, 190, Math.max(190, window.innerHeight - 150)));
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); document.body.classList.remove('resizing-layout'); };
    document.body.classList.add('resizing-layout');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };
  useEffect(() => window.archipelago?.onLog((value) => setLogs((current) => [...current, ...value.trim().split(/\r?\n/).filter(Boolean)])), []);
  useEffect(() => {
    const bridge = window.archipelago;
    if (!bridge?.hostStatus || !bridge.onHostStatus) return;
    void bridge.hostStatus().then((status) => { setHostRunning(status.running); setActiveHostRoomId(status.roomId ?? undefined); });
    return bridge.onHostStatus((status) => {
      setHostRunning(status.running);
      setActiveHostRoomId(status.running ? status.roomId ?? undefined : undefined);
      if (!status.running) setLogs((current) => [...current, status.error ? `Host stopped: ${status.error}` : 'Local host stopped.']);
    });
  }, []);
  useEffect(() => window.archipelago?.onYamlValidationProgress((progress) => setValidationProgress(progress)), []);
  useEffect(() => {
    const bridge = window.archipelago;
    if (!bridge) return;
    const removeConsole = bridge.onConsoleEvent((event) => setConsoleEvents((current) => [...current, event].slice(-500)));
    const removeRemote = bridge.onRemoteStatus((status) => setRemoteState(status.state));
    void bridge.remoteStatus().then((status) => setRemoteState(status.state));
    return () => { removeConsole(); removeRemote(); };
  }, []);
  useEffect(() => {
    const password = legacyPassword.current;
    if (!password || !window.archipelago) return;
    legacyPassword.current = '';
    void window.archipelago.setSecret({ id: 'host:room', value: password }).then(() => {
      setState((current) => ({ ...current, host: { ...current.host, roomPasswordRef: 'host:room', roomPasswordSet: true } }));
    });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!window.archipelago || !state.settings.installRoot) { setApUpdate(undefined); return; }
    let active = true;
    void window.archipelago.checkArchipelagoUpdate({ installRoot: state.settings.installRoot }).then((result) => active && setApUpdate(result));
    return () => { active = false; };
  }, [state.settings.installRoot]);
  useEffect(() => {
    if (!window.archipelago || !state.settings.installRoot || (Object.keys(state.host.document ?? {}).length && Object.keys(state.host.comments ?? {}).length)) return;
    let active = true;
    void window.archipelago.readHostConfig(state.settings.installRoot).then((result) => {
      if (active && result.ok && result.document) setState((current) => ({ ...current, host: { ...current.host, document: Object.keys(current.host.document ?? {}).length ? current.host.document : result.document!, comments: result.comments ?? {} } }));
    });
    return () => { active = false; };
  }, [state.settings.installRoot, state.host.document, state.host.comments]);

  const adoptedSlotLockSourceIds = useMemo(() => new Set(state.slotLockControllers.filter((config) => config.enabled && config.sourceTemplateId).map((config) => config.sourceTemplateId!)), [state.slotLockControllers]);
  const selected = useMemo(() => state.templates.filter((template) => state.selectedIds.includes(template.id) && !adoptedSlotLockSourceIds.has(template.id)).map((template) => {
    const player = assignedPlayer(template, state.players);
    return player ? { ...template, playerId: player.id, slotName: player.preferredSlot || player.name } : template;
  }), [state.templates, state.selectedIds, state.players, adoptedSlotLockSourceIds]);
  const templateGamesKey = useMemo(() => [...new Set(state.templates.map((template) => template.game.trim()))].sort().join('\u0000'), [state.templates]);
  useEffect(() => {
    if (!window.archipelago || !state.settings.installRoot || !templateGamesKey) return;
    const games = templateGamesKey.split('\u0000');
    let active = true;
    void window.archipelago.resolveYamlGames({ installRoot: state.settings.installRoot, games }).then((matches) => {
      if (!active) return;
      const byGame = new Map(matches.map((match) => [match.game.toLocaleLowerCase(), match]));
      setState((current) => {
        let changed = false;
        const templates = current.templates.map((template) => {
          const worldMatch = byGame.get(template.game.trim().toLocaleLowerCase());
          if (!worldMatch || JSON.stringify(worldMatch) === JSON.stringify(template.worldMatch)) return template;
          changed = true;
          return { ...template, worldMatch };
        });
        return changed ? { ...current, templates } : current;
      });
    }).catch((error) => setLogs((current) => [...current, `APWorld matching failed: ${error instanceof Error ? error.message : String(error)}`]));
    return () => { active = false; };
  }, [state.settings.installRoot, templateGamesKey, view]);
  useEffect(() => {
    if (!window.archipelago || !state.settings.installRoot) { setSlotLockWorldMatch(undefined); return; }
    let active = true;
    void window.archipelago.resolveYamlGames({ installRoot: state.settings.installRoot, games: ['SlotLock'] })
      .then((matches) => { if (active) setSlotLockWorldMatch(matches[0]); })
      .catch((error) => setLogs((current) => [...current, `SlotLock APWorld matching failed: ${error instanceof Error ? error.message : String(error)}`]));
    return () => { active = false; };
  }, [state.settings.installRoot, view]);
  useEffect(() => {
    let active = true;
    if (!window.archipelago) return;
    const adoptedSources = state.templates.filter((template) => adoptedSlotLockSourceIds.has(template.id));
    const checked = [...selected, ...adoptedSources.filter((source) => !selected.some((template) => template.id === source.id))];
    Promise.all(checked.map(async (template) => ({ id: template.id, exists: await window.archipelago!.exists(template.path) }))).then((results) => {
      if (active) setMissingTemplateIds(results.filter((item) => !item.exists).map((item) => item.id));
    });
    return () => { active = false; };
  }, [selected, state.templates, adoptedSlotLockSourceIds]);
  useEffect(() => {
    let active = true;
    if (!window.archipelago || !state.settings.installRoot) { setGeneratorExists(false); return; }
    window.archipelago.exists(installedProgram(state.settings.installRoot, 'ArchipelagoGenerate.exe')).then((exists) => active && setGeneratorExists(exists));
    return () => { active = false; };
  }, [state.settings.installRoot]);
  const prepared = useMemo(() => prepareTemplates(selected.filter((template) => template.errors.length === 0)), [selected]);
  const slotLockTargetGroups = useMemo(() => buildSlotLockTargetGroups(prepared, state.players), [prepared, state.players]);
  const managedSlotLocks = useMemo(() => {
    const allSlotNames = prepared.map((template) => template.resolvedSlotName);
    const enabledConfigs = state.slotLockControllers.filter((config) => config.enabled);
    return enabledConfigs.map((config) => {
      const group = slotLockTargetGroups.find((item) => item.player.id === config.playerId);
      const targets = (group?.templates ?? []).filter((template) => !config.excludedTemplateIds.includes(template.id));
      const source = config.sourceTemplateId ? state.templates.find((template) => template.id === config.sourceTemplateId) : undefined;
      const occupiedNames = [...allSlotNames, ...enabledConfigs.filter((item) => item.playerId !== config.playerId).map((item) => item.slotName)];
      const template = createSlotLockTemplate(config, targets, source, slotLockWorldMatch, occupiedNames);
      return { ...template, sourceSlotName: template.slotName, resolvedSlotName: template.slotName, changed: false, preparedContent: template.content };
    });
  }, [prepared, slotLockTargetGroups, state.slotLockControllers, state.templates, slotLockWorldMatch]);
  const sessionPrepared = useMemo(() => [...prepared, ...managedSlotLocks], [prepared, managedSlotLocks]);
  const sessionTemplates = useMemo(() => sessionPrepared.map((template) => ({ ...template, content: template.preparedContent, slotName: template.resolvedSlotName })), [sessionPrepared]);
  const sessionValidationFingerprint = useMemo(() => validationFingerprint(sessionPrepared.map((template) => template.preparedContent).join('\u0000')), [sessionPrepared]);
  const rawHostError = validateRawHostYaml(state.host.raw);
  const duplicateCount = prepared.filter((template) => template.changed).length;
  const playerCount = new Set(selected.filter((template) => template.game.toLocaleLowerCase() !== 'slotlock').map((template) => playerIdentity(template, state.players))).size;
  const blockingWorlds = sessionTemplates.filter((template) => template.id.startsWith('slotlock-controller:')
    ? !template.worldMatch || !['Installed', 'Installed with override'].includes(template.worldMatch.status)
    : !template.worldMatch || ['Missing', 'Installed but incompatible', 'Ambiguous'].includes(template.worldMatch.status));
  const validationStates = sessionPrepared.map((template) => templateValidationStatus(template, sessionValidationFingerprint));
  const rejectedValidationCount = validationStates.filter((status) => status === 'Rejected').length;
  const checkedValidationCount = validationStates.filter((status) => status === 'Valid').length;
  const unassignedSelectedCount = prepared.filter((template) => !template.playerId && template.game.trim().toLocaleLowerCase() !== 'slotlock').length;
  const readiness = [
    { label: 'Player templates selected', ok: selected.length > 0, detail: `${sessionTemplates.length} session slots` },
    { label: 'Template YAML valid', ok: selected.length > 0 && sessionTemplates.every((item) => item.errors.length === 0), detail: sessionTemplates.some((item) => item.errors.length) ? 'Review template or SlotLock errors' : 'No parse errors' },
    { label: 'Source files available', ok: selected.length > 0 && missingTemplateIds.length === 0, detail: missingTemplateIds.length ? `${missingTemplateIds.length} missing or unreadable` : 'All files readable' },
    { label: 'Game worlds installed', ok: selected.length > 0 && blockingWorlds.length === 0, detail: !selected.length ? 'Select YAMLs first' : blockingWorlds.length ? `${blockingWorlds.length} missing, incompatible, or ambiguous` : 'All games resolved', blocking: true },
    { label: 'AP option validation', ok: selected.length > 0 && checkedValidationCount === sessionTemplates.length, detail: !selected.length ? 'Select YAMLs first' : rejectedValidationCount ? `${rejectedValidationCount} rejected by Archipelago` : checkedValidationCount === sessionTemplates.length ? 'Complete session accepted' : `${checkedValidationCount} valid · ${sessionTemplates.length - checkedValidationCount} not checked or stale`, blocking: rejectedValidationCount > 0 || managedSlotLocks.length > 0 },
    { label: 'Slot names unique', ok: selected.length > 0, detail: duplicateCount ? `${duplicateCount} working copies renamed` : 'No conflicts' },
    { label: 'SlotLock roster ownership', ok: managedSlotLocks.length === 0 || unassignedSelectedCount === 0, detail: managedSlotLocks.length === 0 ? 'No managed controllers enabled' : unassignedSelectedCount ? `${unassignedSelectedCount} selected YAML${unassignedSelectedCount === 1 ? '' : 's'} must be assigned in Player Roster` : 'Every game belongs to a roster player' },
    { label: 'Host configuration valid', ok: !rawHostError, detail: rawHostError ?? `${state.host.host || 'Default interface'}:${state.host.port}` },
    { label: 'Generator configured', ok: generatorExists, detail: generatorExists ? installedProgram(state.settings.installRoot, 'ArchipelagoGenerate.exe') : 'Generator missing from installation folder' },
    { label: 'Output folder configured', ok: Boolean(resolvedPaths.outputRoot), detail: resolvedPaths.outputRoot || 'Set path in Settings' },
  ];
  const ready = readiness.every((item) => item.ok || item.blocking === false);

  const patchState = (patch: Partial<AppState>) => setState((current) => ({ ...current, ...patch }));
  const notify = (message: string) => setToast(message);
  useEffect(() => {
    const bridge = window.archipelago;
    if (!bridge?.takeRoomApWorldInstall || !bridge.onRoomApWorldInstall) return;
    const install = async (worldId: 'tracker' | 'slotlock') => {
      if (!window.confirm(`${worldId === 'tracker' ? 'Universal Tracker' : 'SlotLock'} is an APWorld package and contains executable Python code. Install the newest compatible indexed release?`)) return;
      const result = await bridge.installRequiredRoomApWorld({ installRoot: state.settings.installRoot, worldId });
      if (!result.installed && result.sourceUrl) await bridge.openExternal(result.sourceUrl);
      notify(result.installed ? `${worldId === 'tracker' ? 'Universal Tracker' : 'SlotLock'} installed` : result.error ?? 'No compatible indexed release is available.');
    };
    void bridge.takeRoomApWorldInstall().then((worldId) => { if (worldId) void install(worldId); });
    return bridge.onRoomApWorldInstall((worldId) => void install(worldId));
  }, [state.settings.installRoot]);
  const hasGameSettings = (game: string, worldIds: string[] = []) => findGameHostSections(state.host.document ?? {}, game, worldIds).length > 0;

  async function checkArchipelagoUpdate(force = false) {
    if (!window.archipelago || !state.settings.installRoot) return;
    setCheckingApUpdate(true);
    try {
      const result = await window.archipelago.checkArchipelagoUpdate({ installRoot: state.settings.installRoot, force });
      setApUpdate(result);
      if (force) notify(result.error ? `Update check unavailable: ${result.error}` : result.state === 'outdated' ? `Archipelago ${result.latestVersion} is available` : `Archipelago ${result.installedVersion} is current`);
    } finally { setCheckingApUpdate(false); }
  }

  function openArchipelagoUpdate() {
    if (!apUpdate) return;
    void window.archipelago?.openExternal(apUpdate.installerUrl || apUpdate.releaseUrl);
  }

  async function addPickedYaml(files: PickedYaml[]) {
    if (!files.length) return;
    const knownPaths = new Set(state.templates.flatMap((item) => [item.path, item.sourcePath].filter(Boolean).map((value) => value!.toLowerCase())));
    const knownContent = new Set(state.templates.map((item) => yamlFingerprint(item.content)));
    const newFiles = files.filter((file) => {
      const sourcePath = file.path.toLowerCase();
      const fingerprint = yamlFingerprint(file.content);
      if (knownPaths.has(sourcePath) || knownContent.has(fingerprint)) return false;
      knownPaths.add(sourcePath);
      knownContent.add(fingerprint);
      return true;
    });
    if (!newFiles.length) { notify('Folder is already imported'); return; }
    let imported = newFiles.map(inspectYaml);
    if (resolvedPaths.libraryPath) {
      const paths = await window.archipelago!.saveLibraryFiles({
        root: resolvedPaths.libraryPath,
        files: imported.map((item) => ({ sourcePath: item.path, game: compactGameName(item.game), name: suggestedFileName(item), content: item.content })),
      });
      imported = imported.map((item, index) => ({ ...item, path: paths[index], fileName: paths[index].split(/[\\/]/).at(-1) ?? item.fileName, errors: item.errors.filter((error) => !error.startsWith('Filename should')) }));
    }
    setState((current) => ({ ...current, templates: [...current.templates, ...imported] }));
    setLogs((current) => [...current, `Imported ${imported.length} template${imported.length === 1 ? '' : 's'}.`]);
    notify(`${imported.length} template${imported.length === 1 ? '' : 's'} imported`);
  }

  async function importYaml() {
    if (!window.archipelago) {
      notify('YAML import is available in the desktop app.');
      return;
    }
    const files = await window.archipelago.pickYamlFiles();
    await addPickedYaml(files);
  }

  async function importSourceFolder(silent = false) {
    if (!window.archipelago || !resolvedPaths.importSource) return;
    try {
      const files = await window.archipelago.readYamlDirectory(resolvedPaths.importSource);
      await addPickedYaml(files);
    } catch (error) {
      if (!silent) notify(error instanceof Error ? error.message : 'Unable to read import folder');
    }
  }

  useEffect(() => {
    if (initialImportStarted.current || state.templates.length > 0 || !window.archipelago) return;
    initialImportStarted.current = true;
    void importSourceFolder(true);
  }, []);

  async function importExistingHistory(silent = false) {
    if (!window.archipelago) return;
    try {
      const imported = await window.archipelago.scanExistingHistory({ outputRoot: resolvedPaths.outputRoot, hostedRoot: resolvedPaths.hostedSessionsPath });
      const runs: HistoryRun[] = imported.map((run) => ({
        id: `import:${run.importKey}`,
        name: run.name,
        createdAt: run.createdAt,
        templateIds: [],
        playerCount: run.playerCount,
        slotCount: run.slotCount,
        games: run.games,
        slots: run.slots,
        outputPath: run.outputPath,
        artifactPath: run.artifactPath,
        savePath: run.savePath,
        seed: run.seed,
        status: 'generated',
        notes: run.seed ? `Imported Archipelago seed ${run.seed}` : 'Imported generated session',
        host: state.host,
        logs: ['Imported from an existing Archipelago session.'],
        slotLockControllers: [],
      }));
      setState((current) => {
        const importedIds = new Set(runs.map((run) => run.id));
        return { ...current, history: [...runs, ...current.history.filter((run) => !importedIds.has(run.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
      });
      if (!silent) notify(`${runs.length} existing sessions found`);
    } catch (error) {
      if (!silent) notify(error instanceof Error ? error.message : 'Unable to import existing sessions');
    }
  }

  useEffect(() => {
    if (initialHistoryScanStarted.current || !window.archipelago) return;
    initialHistoryScanStarted.current = true;
    void importExistingHistory(true);
  }, []);

  function toggleTemplate(id: string) {
    setState((current) => ({
      ...current,
      selectedIds: current.selectedIds.includes(id) ? current.selectedIds.filter((value) => value !== id) : [...current.selectedIds, id],
    }));
  }

  async function copyErrors() {
    const validationDetails = sessionPrepared.flatMap((item) => item.apValidation?.output ? [`${item.fileName} AP validation (${templateValidationStatus(item, sessionValidationFingerprint)}):\n${item.apValidation.output}`] : []);
    const details = [...sessionPrepared.flatMap((item) => item.errors.map((error) => `${item.fileName}: ${error}`)), ...validationDetails, ...logs.slice(-30)].join('\n\n');
    await navigator.clipboard.writeText(details || 'No errors reported.');
    notify('Error details copied');
  }

  async function dryRun() {
    await validateTemplates(sessionTemplates, true, sessionPrepared);
  }

  async function validateTemplates(templates: Template[], sessionContext = false, preparedTemplates?: ReturnType<typeof prepareTemplates>) {
    if (!templates.length || !window.archipelago || running !== 'idle') return;
    setRunning('validating');
    setValidationProgress({ jobId: '', index: 0, total: templates.length, state: 'started' });
    setLogs((current) => [...current, `Validating ${templates.length} YAML${templates.length === 1 ? '' : 's'} against installed APWorlds...`]);
    const validationTemplates = preparedTemplates ?? (sessionContext ? prepareTemplates(templates) : templates.map((template) => ({ ...template, preparedContent: template.content })));
    const response = await window.archipelago.validateYamls({
      installRoot: state.settings.installRoot,
      sessionContext,
      templates: validationTemplates.map((template) => ({ id: template.id, fileName: template.fileName, content: template.preparedContent, sourceFingerprint: validationFingerprint(template.content) })),
    });
    if (response.ok) {
      const resultById = new Map(response.results.map((item) => [item.templateId, item.result]));
      setState((current) => ({
        ...current,
        templates: current.templates.map((template) => resultById.has(template.id) ? { ...template, apValidation: resultById.get(template.id) } : template),
        slotLockControllers: current.slotLockControllers.map((config) => {
          const result = resultById.get(`slotlock-controller:${config.playerId}`);
          return result ? { ...config, apValidation: result } : config;
        }),
      }));
      const valid = response.results.filter((item) => item.result.status === 'Valid').length;
      const failed = response.results.length - valid;
      setLogs((current) => [...current, `AP validation complete: ${valid} valid${failed ? `, ${failed} need attention` : ''}.`]);
      notify(failed ? `${failed} YAML${failed === 1 ? '' : 's'} need attention` : 'All YAMLs accepted by Archipelago');
    } else {
      setLogs((current) => [...current, `AP validation failed: ${response.error}`]);
      notify(response.error || 'AP validation failed');
    }
    setRunning('idle');
  }

  async function cancelValidation() {
    const result = await window.archipelago?.cancelYamlValidation();
    if (result?.cancelled) notify('Stopping after the current validation process exits');
  }

  function findApWorld(game: string) {
    setApWorldQuery(game);
    setView('apworlds');
  }

  async function generate() {
    if (!ready || !window.archipelago) return;
    setRunning('generating');
    const now = new Date().toISOString();
    setLogs((current) => [...current, `Preparing ${sessionPrepared.length} working YAML copies...`]);
    const payload = {
      sessionName: state.sessionName,
      outputRoot: resolvedPaths.outputRoot,
      installRoot: state.settings.installRoot,
      generatorArgs: state.settings.generatorArgs,
      files: sessionPrepared.map((item) => ({ name: item.game === 'SlotLock' && item.id.startsWith('slotlock-controller:') ? item.fileName : suggestedFileName(item), content: item.preparedContent })),
      hostYaml: hostYaml(state.host),
      hostSettings: state.host,
      metadata: { name: state.sessionName, notes: state.sessionNotes, createdAt: now, templates: sessionPrepared.map((item) => ({ source: item.path, game: item.game, originalSlot: item.sourceSlotName, slot: item.resolvedSlotName })), slotLockControllers: state.slotLockControllers.filter((config) => config.enabled) },
    };
    const result = await window.archipelago.generate(payload);
    const run: HistoryRun = {
      id: crypto.randomUUID(), name: state.sessionName, createdAt: now, templateIds: state.selectedIds,
      playerCount, slotCount: sessionPrepared.length, games: [...new Set(sessionPrepared.map((item) => item.game))],
      slots: sessionPrepared.map((item) => ({ game: item.game, name: item.resolvedSlotName, originalName: item.sourceSlotName })),
      outputPath: result.outputPath ?? '', status: result.ok ? 'generated' : 'failed', notes: state.sessionNotes,
      artifactPath: result.artifactPath,
      host: state.host, logs: [...logs, result.ok ? 'Generation complete.' : `Generation failed: ${result.error}`],
      slotLockControllers: state.slotLockControllers.map((config) => ({ ...config, excludedTemplateIds: [...config.excludedTemplateIds], options: { ...config.options } })),
    };
    const localRoom = result.ok ? await buildLocalRoom(run) : undefined;
    setState((current) => ({
      ...current,
      templates: current.templates.map((item) => current.selectedIds.includes(item.id) || adoptedSlotLockSourceIds.has(item.id) ? { ...item, lastUsed: now } : item),
      history: [run, ...current.history],
      rooms: localRoom ? [localRoom, ...current.rooms.filter((room) => room.id !== localRoom.id)] : current.rooms,
    }));
    setLogs((current) => [...current, result.ok ? `Generation complete: ${result.outputPath}` : `Generation failed: ${result.error}`]);
    setRunning('idle');
  }

  async function buildLocalRoom(run: HistoryRun): Promise<ManagedRoom | undefined> {
    if (!window.archipelago || !run.outputPath || !run.slots?.length) return undefined;
    const existing = state.rooms.find((room) => room.provider?.type === 'local' && room.provider.historyRunId === run.id);
    if (existing) return existing;
    const roomId = `local-${crypto.randomUUID()}`;
    const adopted = await window.archipelago.adoptLocalRoom({
      roomsRoot: resolvedPaths.roomsRoot, roomId, label: run.name, sessionPath: run.outputPath,
      artifactPath: run.artifactPath, slots: run.slots.map((slot, index) => ({ ...slot, slot: index + 1 })),
    });
    if (!adopted.folderPath || !adopted.slots) { notify(adopted.error ?? 'Could not create the local room'); return undefined; }
    if (adopted.unresolved?.length) setLogs((current) => [...current, `${adopted.unresolved!.length} generated file${adopted.unresolved!.length === 1 ? '' : 's'} could not be assigned to a room slot.`]);
    return {
      id: roomId, label: run.name, url: `local://room/${roomId}`, folderPath: adopted.folderPath,
      createdAt: new Date().toISOString(), passwordRef: run.host.roomPasswordRef, passwordSet: run.host.roomPasswordSet,
      autoLoginWarningAccepted: false, apiVisible: true, provider: { type: 'local', historyRunId: run.id }, slots: adopted.slots,
      status: { lastPort: run.host.port, endpoint: { host: 'localhost', port: run.host.port, secure: false }, refreshedAt: new Date().toISOString(), stale: false },
      hosted: {
        historyRunId: run.id, sessionPath: run.outputPath, artifactPath: run.artifactPath, savePath: run.savePath,
        advertisedHost: '', gamePort: run.host.port || 38281, portalPort: run.host.port === 65535 ? 38282 : (run.host.port || 38281) + 1,
        publicBaseUrl: '', automaticPortMapping: true, insecureHttpAccepted: false,
        sharedSlots: adopted.slots.filter((slot) => slot.downloadAvailable).map((slot) => slot.slot),
        shareStatus: { state: 'offline', serverRunning: false, portalRunning: false, mapping: 'unknown', reachability: 'unknown' },
      },
    };
  }

  async function adoptHistoryRoom(run: HistoryRun) {
    const room = await buildLocalRoom(run);
    if (!room) return;
    setState((current) => ({ ...current, rooms: [room, ...current.rooms.filter((item) => item.id !== room.id)] }));
    setView('rooms');
    notify('Local room created');
  }

  async function hostLatest(run?: HistoryRun, roomId?: string) {
    const target = run ?? state.history.find((item) => item.status === 'generated');
    if (!target || !window.archipelago) return;
    setRunning('hosting');
    if (remoteState !== 'disconnected') { notify('Disconnect the remote console before starting a local host'); return; }
    const localRoom = roomId ? state.rooms.find((room) => room.id === roomId) : undefined;
    const hostSettings = localRoom?.hosted ? {
      ...target.host,
      host: state.settings.roomGatewayMode === 'managed' ? 'localhost' : target.host.host,
      port: localRoom.hosted.gamePort,
    } : target.host;
    const trackerSlots = localRoom?.slots ?? (target.slots ?? []).map((slot, index) => ({ ...slot, slot: index + 1 }));
    const result = await window.archipelago.host({ roomId, installRoot: state.settings.installRoot, sessionPath: target.outputPath, artifactPath: target.artifactPath, savePath: target.savePath, hostSettings, slots: trackerSlots });
    setLogs((current) => [...current, result.ok ? `Local host started for ${target.name}.` : `Host failed: ${result.error}`]);
    const slotSummary = target.slots?.map((slot) => `${slot.game}: ${slot.name}`).join(' | ');
    if (result.ok && slotSummary) setConsoleEvents((current) => [...current, { target: 'local', level: 'info', text: `Connection slots: ${slotSummary}`, timestamp: new Date().toISOString() }]);
    if (result.ok) setHostRunning(true);
    setRunning('idle');
  }

  async function stopHost() {
    const result = await window.archipelago?.stopHost();
    if (result?.ok) setHostRunning(false);
    else notify('The local host could not be stopped');
  }

  function cloneRun(run: HistoryRun) {
    patchState({ sessionName: `${run.name} Copy`, sessionNotes: run.notes, selectedIds: run.templateIds.filter((id) => state.templates.some((item) => item.id === id)), host: run.host, slotLockControllers: run.slotLockControllers ?? [] });
    setView('build');
    notify('Session cloned');
  }

  function assignTemplate(templateId: string, playerId: string, mode: 'copy' | 'move') {
    const player = state.players.find((item) => item.id === playerId);
    const template = state.templates.find((item) => item.id === templateId);
    if (!player || !template) return;
    const slotName = player.preferredSlot || player.name;
    if (mode === 'move') {
      setState((current) => ({ ...current, templates: current.templates.map((item) => item.id === templateId ? { ...item, playerId, slotName } : item) }));
      notify(`${template.game} moved to ${player.name}`);
      return;
    }
    const copy: Template = { ...template, id: crypto.randomUUID(), playerId, slotName, derivedFromId: template.derivedFromId ?? template.id, importedAt: new Date().toISOString(), lastUsed: undefined };
    setState((current) => ({ ...current, templates: [...current.templates, copy] }));
    notify(`${template.game} copied to ${player.name}`);
  }

  function togglePlayerTemplate(templateId: string) {
    toggleTemplate(templateId);
  }

  function selectPlayerTemplates(player: Player) {
    const ids = state.templates.filter((template) => playerIdentity(template, state.players) === `roster:${player.id}`).map((template) => template.id);
    const allSelected = ids.length > 0 && ids.every((id) => state.selectedIds.includes(id));
    setState((current) => ({ ...current, selectedIds: allSelected ? current.selectedIds.filter((id) => !ids.includes(id)) : [...new Set([...current.selectedIds, ...ids])] }));
  }

  async function exportPlayerTemplate(template: Template, player: Player) {
    if (!window.archipelago) return;
    const slotName = player.preferredSlot || player.name;
    const result = await window.archipelago.exportYaml({ fileName: exportedYamlName(template, player.name), content: contentWithSlotName(template.content, slotName) });
    if (result.ok) notify(`Exported ${template.game} for ${player.name}`);
  }

  async function exportPlayerPack(player: Player) {
    if (!window.archipelago) return;
    const assigned = state.templates.filter((template) => playerIdentity(template, state.players) === `roster:${player.id}`);
    const slotName = player.preferredSlot || player.name;
    const result = await window.archipelago.exportYamlPack({ files: assigned.map((template) => ({ name: exportedYamlName(template, player.name), content: contentWithSlotName(template.content, slotName) })) });
    if (result.ok) notify(`Exported ${result.paths.length} YAMLs for ${player.name}`);
  }

  function savePreset() {
    const preset: SessionPreset = { id: crypto.randomUUID(), name: state.sessionName, templateIds: state.selectedIds, notes: state.sessionNotes, host: state.host, slotLockControllers: state.slotLockControllers };
    patchState({ presets: [preset, ...state.presets.filter((item) => item.name !== preset.name)] });
    notify('Session preset saved');
  }

  function loadPreset(id: string) {
    const preset = state.presets.find((item) => item.id === id);
    if (!preset) return;
    patchState({ sessionName: preset.name, sessionNotes: preset.notes, selectedIds: preset.templateIds.filter((templateId) => state.templates.some((item) => item.id === templateId)), host: preset.host, slotLockControllers: preset.slotLockControllers ?? [] });
    notify('Preset loaded');
  }

  async function connectRoomConsole(profile: RemoteProfile) {
    const result = await window.archipelago?.connectRemote(profile);
    if (!result?.ok) { notify(result?.error ?? 'Room console connection failed'); return; }
    setLogsOpen(true);
    notify(`Connecting to ${profile.label} as ${profile.slotName}`);
  }

  const content = view === 'build' ? (
    <SessionBuild state={state} patchState={patchState} selected={selected} prepared={prepared} sessionPrepared={sessionPrepared} slotLockWorldMatch={slotLockWorldMatch} search={search} setSearch={setSearch}
      toggleTemplate={toggleTemplate} importYaml={importYaml} readiness={readiness} ready={ready} running={running} generate={generate}
      playerCount={playerCount} outputRoot={resolvedPaths.outputRoot} validationContextFingerprint={sessionValidationFingerprint} dryRun={dryRun} cancelValidation={cancelValidation} validationProgress={validationProgress} rawHostError={rawHostError} setView={setView} savePreset={savePreset} loadPreset={loadPreset} hasGameSettings={hasGameSettings} openGameSettings={(target) => setGameSettingsTarget(target)} />
  ) : view === 'library' ? (
    <TemplateLibrary templates={state.templates} players={state.players} importYaml={importYaml} importFolder={() => importSourceFolder()} sourcePath={resolvedPaths.importSource} updateTemplate={(id, patch) => setState((current) => ({ ...current, templates: current.templates.map((item) => item.id === id ? { ...item, ...patch } : item) }))} remove={(id) => setState((current) => ({ ...current, templates: current.templates.filter((item) => item.id !== id), selectedIds: current.selectedIds.filter((value) => value !== id) }))} validate={(templates) => void validateTemplates(templates)} cancelValidation={() => void cancelValidation()} validationProgress={validationProgress} validating={running === 'validating'} findApWorld={findApWorld} hasGameSettings={hasGameSettings} openGameSettings={(target) => setGameSettingsTarget(target)} notify={notify} />
  ) : view === 'roster' ? (
    <Roster players={state.players} templates={state.templates} selectedIds={state.selectedIds} setPlayers={(players) => patchState({ players })} assignTemplate={assignTemplate} toggleTemplate={togglePlayerTemplate} selectPlayerTemplates={selectPlayerTemplates} exportTemplate={exportPlayerTemplate} exportPack={exportPlayerPack} />
  ) : view === 'history' ? (
    <HistoryView history={state.history} rooms={state.rooms} cloneRun={cloneRun} hostRun={hostLatest} adoptRoom={(run) => void adoptHistoryRoom(run)} reveal={(path) => window.archipelago?.reveal(path)} openBuild={() => setView('build')} refreshHistory={() => importExistingHistory()} />
  ) : view === 'rooms' ? (
    <RoomsView rooms={state.rooms} history={state.history} templates={state.templates} settings={state.settings} roomsRoot={resolvedPaths.roomsRoot} setRooms={(rooms) => patchState({ rooms })} notify={notify} connectConsole={connectRoomConsole} associations={state.popTrackerAssociations} setAssociations={(popTrackerAssociations) => patchState({ popTrackerAssociations })} launchProfiles={state.gameLaunchProfiles} setLaunchProfiles={(gameLaunchProfiles) => patchState({ gameLaunchProfiles })} hostRunning={hostRunning} activeHostRoomId={activeHostRoomId} startLocal={(room) => { const run = state.history.find((item) => item.id === room.hosted?.historyRunId); if (run) void hostLatest(run, room.id); }} stopLocal={() => void stopHost()} openLocalConsole={() => setLogsOpen(true)} />
  ) : view === 'server' ? (
    <ServerSettingsView host={state.host} installRoot={state.settings.installRoot} setHost={(host) => patchState({ host })} notify={notify} />
  ) : view === 'apworlds' ? (
    <ApWorldsView installRoot={state.settings.installRoot} notify={notify} openSettings={() => setView('settings')} initialSearch={apWorldQuery} hasGameSettings={hasGameSettings} openGameSettings={(target) => setGameSettingsTarget(target)} />
  ) : view === 'tools' ? (
    <ToolsView settings={state.settings} refreshTemplates={() => importSourceFolder()} notify={notify} openApWorlds={() => setView('apworlds')} />
  ) : (
    <SettingsView state={state} patchState={patchState} brokerState={roomBrokerState} apUpdate={apUpdate} checkingApUpdate={checkingApUpdate} checkArchipelagoUpdate={() => void checkArchipelagoUpdate(true)} openArchipelagoUpdate={openArchipelagoUpdate} />
  );

  return (
    <div className="app-shell" style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
      <aside className={`nav-rail ${navOpen ? 'open' : ''}`}>
        <div className="brand-mark"><div className="brand-icon"><img src="./icon.png" alt="" /></div><div><strong>Archipelago</strong><span>Controller</span></div></div>
        <nav>{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => { setView(id); setNavOpen(false); }}><Icon size={18} /><span>{label}</span>{id === 'history' && state.history.length > 0 && <em>{state.history.length}</em>}</button>)}</nav>
        <div className="nav-status"><span className={`status-dot ${electronReady ? 'online' : ''}`} /><div><strong>{electronReady ? 'Desktop connected' : 'Browser preview'}</strong><span>{state.settings.installRoot ? 'Installation configured' : 'Setup required'}</span></div></div>
        <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize navigation" title="Drag to resize navigation" onPointerDown={resizeSidebar} />
      </aside>
      <main className={`app-main ${apUpdate?.state === 'outdated' ? 'has-ap-warning' : ''}`}>
        <header className="topbar">
          <IconButton label="Open navigation" onClick={() => setNavOpen((open) => !open)}><Menu size={19} /></IconButton>
          <div><span className="topbar-context">Workspace</span><strong>{navItems.find((item) => item.id === view)?.label}</strong></div>
          <div className="topbar-actions">
            <button className="text-button" onClick={() => window.archipelago?.openExternal(state.settings.launchUrl)}><ExternalLink size={16} />Launch site</button>
            {hostRunning ? <button className="stop-button" onClick={stopHost}><Square size={14} />Stop host</button> : <button className="primary-button compact" disabled={!state.history.some((item) => item.status === 'generated') || running !== 'idle'} onClick={() => hostLatest()}><Server size={16} />Host latest</button>}
          </div>
        </header>
        {apUpdate?.state === 'outdated' && <div className="ap-update-warning" role="alert"><CircleAlert size={20} /><div><strong>Archipelago is out of date</strong><span>Installed {apUpdate.installedVersion} · Latest {apUpdate.latestVersion}</span></div><button className="update-button" onClick={openArchipelagoUpdate}><Download size={15} />Update Archipelago</button></div>}
        <div className="view-content" ref={viewContentRef}>{content}</div>
        <ConsoleDrawer open={logsOpen} setOpen={setLogsOpen} activity={logs} setActivity={setLogs} events={consoleEvents} setEvents={setConsoleEvents}
          running={running} hostRunning={hostRunning} remoteState={remoteState} profiles={state.remoteProfiles}
          hostSettings={state.host} canStartLocal={state.history.some((item) => item.status === 'generated')} startLocal={() => void hostLatest()}
          setProfiles={(remoteProfiles) => patchState({ remoteProfiles })} copyErrors={copyErrors} notify={notify} height={consoleHeight} onResize={resizeConsole} />
      </main>
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
      {gameSettingsTarget && <GameSettingsDialog target={gameSettingsTarget} host={state.host} installRoot={state.settings.installRoot} setHost={(host) => patchState({ host })} notify={notify} onClose={() => setGameSettingsTarget(undefined)} />}
    </div>
  );
}

function ConsoleDrawer({ open, setOpen, activity, setActivity, events, setEvents, running, hostRunning, remoteState, profiles, hostSettings, canStartLocal, startLocal, setProfiles, copyErrors, notify, height, onResize }: {
  open: boolean; setOpen: (value: boolean) => void; activity: string[]; setActivity: React.Dispatch<React.SetStateAction<string[]>>;
  events: ConsoleEvent[]; setEvents: React.Dispatch<React.SetStateAction<ConsoleEvent[]>>; running: string; hostRunning: boolean;
  remoteState: ConsoleConnectionState; profiles: RemoteProfile[]; setProfiles: (profiles: RemoteProfile[]) => void;
  hostSettings: AppState['host']; canStartLocal: boolean; startLocal: () => void;
  copyErrors: () => void; notify: (message: string) => void;
  height: number; onResize: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const [tab, setTab] = useState<'console' | 'activity'>('console');
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showConnect, setShowConnect] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState(profiles[0]?.id ?? '');
  const [editingProfileId, setEditingProfileId] = useState('');
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [draft, setDraft] = useState({ label: '', address: '', slotName: '', roomPassword: '', serverPassword: '' });
  const target = hostRunning ? 'local' : remoteState !== 'disconnected' ? 'remote' : 'none';
  const statusLabel = hostRunning ? 'Local' : remoteState === 'admin' ? 'Admin' : remoteState === 'chat' ? 'Chat' : remoteState === 'connecting' ? 'Connecting' : 'Disconnected';

  const submit = async (value = command) => {
    const text = value.trim();
    if (!text || !window.archipelago) return;
    const result = target === 'local' ? await window.archipelago.sendHostInput(text)
      : target === 'remote' ? await window.archipelago.sendRemoteInput(text)
      : { ok: false, error: 'Start a local host or connect to a remote room first.' };
    if (!result.ok) notify(result.error ?? 'Console input failed');
    else {
      if (!/^!admin\s+login\b/i.test(text)) setHistory((current) => [...current.filter((item) => item !== text), text].slice(-50));
      setCommand('');
      setHistoryIndex(-1);
    }
  };

  const connect = async (profile: RemoteProfile) => {
    const connectedProfile = { ...profile, lastConnectedAt: new Date().toISOString() };
    const connectionProfile = !connectedProfile.serverPasswordSet && hostSettings.serverPasswordSet
      ? { ...connectedProfile, serverPasswordRef: hostSettings.serverPasswordRef, serverPasswordSet: true }
      : connectedProfile;
    const result = await window.archipelago?.connectRemote(connectionProfile);
    if (!result?.ok) notify(result?.error ?? 'Remote connection failed');
    else { setProfiles(profiles.some((item) => item.id === profile.id) ? profiles.map((item) => item.id === profile.id ? connectedProfile : item) : [connectedProfile, ...profiles]); setSelectedProfileId(profile.id); setShowConnect(false); setTab('console'); setOpen(true); }
  };

  const loginAdmin = async () => {
    const profile = profiles.find((item) => item.id === selectedProfileId);
    let secretRef = profile?.serverPasswordSet ? profile.serverPasswordRef : hostSettings.serverPasswordSet ? hostSettings.serverPasswordRef : undefined;
    if (adminPassword && window.archipelago) {
      secretRef = profile?.serverPasswordRef ?? `profile:${profile?.id ?? 'temporary'}:server`;
      await window.archipelago.setSecret({ id: secretRef, value: adminPassword });
      if (profile) setProfiles(profiles.map((item) => item.id === profile.id ? { ...item, serverPasswordRef: secretRef, serverPasswordSet: true } : item));
      setAdminPassword('');
    }
    if (!secretRef) { setShowAdminPassword(true); return; }
    const result = await window.archipelago?.remoteAdminLogin(secretRef);
    if (!result?.ok) notify(result?.error ?? 'Admin login failed');
    else setShowAdminPassword(false);
  };

  const saveAndConnect = async () => {
    if (!draft.label.trim() || !draft.address.trim() || !draft.slotName.trim() || !window.archipelago) { notify('Label, address, and slot name are required'); return; }
    const existing = profiles.find((item) => item.id === editingProfileId);
    const id = existing?.id ?? crypto.randomUUID();
    const roomPasswordRef = existing?.roomPasswordRef ?? `profile:${id}:room`;
    const serverPasswordRef = existing?.serverPasswordRef ?? `profile:${id}:server`;
    if (draft.roomPassword) await window.archipelago.setSecret({ id: roomPasswordRef, value: draft.roomPassword });
    if (draft.serverPassword) await window.archipelago.setSecret({ id: serverPasswordRef, value: draft.serverPassword });
    const profile: RemoteProfile = { id, label: draft.label.trim(), address: draft.address.trim(), slotName: draft.slotName.trim(),
      roomPasswordRef, roomPasswordSet: Boolean(draft.roomPassword) || Boolean(existing?.roomPasswordSet), serverPasswordRef, serverPasswordSet: Boolean(draft.serverPassword) || Boolean(existing?.serverPasswordSet), lastConnectedAt: new Date().toISOString() };
    const nextProfiles = existing ? profiles.map((item) => item.id === id ? profile : item) : [profile, ...profiles];
    setProfiles(nextProfiles);
    setEditingProfileId('');
    setDraft({ label: '', address: '', slotName: '', roomPassword: '', serverPassword: '' });
    await connect(profile);
  };

  const removeProfile = async (profile: RemoteProfile) => {
    if (profile.roomPasswordRef) await window.archipelago?.removeSecret(profile.roomPasswordRef);
    if (profile.serverPasswordRef) await window.archipelago?.removeSecret(profile.serverPasswordRef);
    setProfiles(profiles.filter((item) => item.id !== profile.id));
    if (selectedProfileId === profile.id) setSelectedProfileId('');
  };

  return <section className={`log-drawer console-drawer ${open ? 'open' : ''}`} style={open ? { height: `${height}px` } : undefined}>
    {open && <div className="console-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize console" title="Drag to resize console" onPointerDown={onResize} />}
    <div className="log-handle"><button className="drawer-toggle" onClick={() => setOpen(!open)}><TerminalSquare size={16} /><strong>Console</strong><ChevronDown size={16} /></button><StatusChip tone={target === 'none' ? 'neutral' : remoteState === 'connecting' ? 'warn' : 'good'}>{statusLabel}</StatusChip><span>{tab === 'console' ? events.at(-1)?.text ?? 'No active connection' : activity.at(-1)}</span></div>
    {open && <div className="log-body console-body">
      <div className="console-toolbar"><div className="console-tabs"><button className={tab === 'console' ? 'active' : ''} onClick={() => setTab('console')}>Console</button><button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button></div><div className="console-actions">
        {target === 'none' && <button className="text-button" disabled={!canStartLocal || running !== 'idle'} onClick={startLocal}><Server size={14} />Start local</button>}
        {target === 'remote' && remoteState === 'chat' && <button className="text-button admin-login-button" onClick={() => void loginAdmin()}><Server size={14} />Admin login</button>}
        {target === 'remote' ? <button className="text-button" onClick={() => void window.archipelago?.disconnectRemote()}>Disconnect</button> : <button className="text-button" disabled={hostRunning} onClick={() => setShowConnect(!showConnect)}>Connect remote</button>}
        <IconButton label="Clear current log" onClick={() => tab === 'console' ? setEvents([]) : setActivity([])}><Trash2 size={14} /></IconButton>
      </div></div>
      {showAdminPassword && target === 'remote' && remoteState === 'chat' && <div className="admin-login-row"><input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void loginAdmin()} placeholder="Server admin password" autoFocus /><button className="primary-button" disabled={!adminPassword} onClick={() => void loginAdmin()}>Log in</button></div>}
      {showConnect && !hostRunning && <div className="remote-connect">
        {profiles.length > 0 && <div className="saved-profiles"><select value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}><option value="">Saved rooms</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.slotName}</option>)}</select><button className="secondary-button" disabled={!selectedProfileId} onClick={() => { const profile = profiles.find((item) => item.id === selectedProfileId); if (profile) void connect(profile); }}>Connect</button><button className="secondary-button" disabled={!selectedProfileId} onClick={() => { const profile = profiles.find((item) => item.id === selectedProfileId); if (!profile) return; setEditingProfileId(profile.id); setDraft({ label: profile.label, address: profile.address, slotName: profile.slotName, roomPassword: '', serverPassword: '' }); }}>Edit</button><IconButton label="Delete selected profile" danger onClick={() => { const profile = profiles.find((item) => item.id === selectedProfileId); if (profile) void removeProfile(profile); }}><Trash2 size={14} /></IconButton></div>}
        <div className="remote-fields"><input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Profile label" /><input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="archipelago.gg:port" /><input value={draft.slotName} onChange={(event) => setDraft({ ...draft, slotName: event.target.value })} placeholder="Slot name" /><input type="password" value={draft.roomPassword} onChange={(event) => setDraft({ ...draft, roomPassword: event.target.value })} placeholder={editingProfileId ? 'Keep room password' : 'Room password (optional)'} /><input type="password" value={draft.serverPassword} onChange={(event) => setDraft({ ...draft, serverPassword: event.target.value })} placeholder={editingProfileId ? 'Keep admin password' : 'Admin server password'} /><button className="primary-button" onClick={() => void saveAndConnect()}>{editingProfileId ? 'Update & connect' : 'Save & connect'}</button></div>
      </div>}
      {tab === 'console' ? <><pre className="console-output">{events.map((event, index) => <span className={event.level} key={`${event.timestamp}-${index}`}><i>{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</i>{event.text}</span>)}</pre><div className="quick-commands">{['/players', '/status', '/save', '/countdown 10'].map((item) => <button key={item} disabled={target === 'none' || (target === 'remote' && remoteState !== 'admin')} onClick={() => void submit(item)}>{item}</button>)}</div><div className="console-input"><input value={command} disabled={target === 'none'} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter') void submit();
        else if (event.key === 'ArrowUp' && history.length) { event.preventDefault(); const next = Math.min(history.length - 1, historyIndex + 1); setHistoryIndex(next); setCommand(history[history.length - 1 - next]); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); const next = historyIndex - 1; setHistoryIndex(next); setCommand(next < 0 ? '' : history[history.length - 1 - next]); }
      }} placeholder={target === 'local' ? 'Message players or enter /host-command' : target === 'remote' ? 'Message players, !command, or /admin-command' : 'Start or connect to a host'} /><IconButton label="Send console input" onClick={() => void submit()}><Send size={15} /></IconButton></div></> : <><div className="log-toolbar"><span>{activity.length} entries</span><button className="text-button" onClick={copyErrors}><Clipboard size={15} />Copy details</button></div><pre className="activity-output">{activity.map((line, index) => <span key={`${index}-${line}`}><i>{String(index + 1).padStart(2, '0')}</i>{line}</span>)}</pre></>}
    </div>}
  </section>;
}

type BuildProps = {
  state: AppState; patchState: (patch: Partial<AppState>) => void; selected: Template[];
  prepared: ReturnType<typeof prepareTemplates>; sessionPrepared: ReturnType<typeof prepareTemplates>; slotLockWorldMatch?: ApWorldMatchResult; search: string; setSearch: (value: string) => void;
  toggleTemplate: (id: string) => void; importYaml: () => void;
  readiness: { label: string; ok: boolean; detail: string; blocking?: boolean }[]; ready: boolean; running: string;
  generate: () => void; dryRun: () => void; cancelValidation: () => void; validationProgress?: ApYamlValidationProgress;
  rawHostError: string | null; setView: (view: View) => void;
  savePreset: () => void; loadPreset: (id: string) => void;
  playerCount: number; outputRoot: string; validationContextFingerprint: string; hasGameSettings: (game: string, worldIds?: string[]) => boolean; openGameSettings: (target: GameSettingsTarget) => void;
};

function SessionBuild({ state, patchState, selected, prepared, sessionPrepared, slotLockWorldMatch, search, setSearch, toggleTemplate, importYaml, readiness, ready, running, generate, dryRun, cancelValidation, validationProgress, rawHostError, setView, savePreset, loadPreset, playerCount, outputRoot, validationContextFingerprint, hasGameSettings, openGameSettings }: BuildProps) {
  const shown = state.templates.filter((item) => `${item.game} ${item.description} ${item.slotName}`.toLowerCase().includes(search.toLowerCase()));
  const targetGroups = buildSlotLockTargetGroups(prepared, state.players);
  const sources = state.templates.filter((template) => template.game.trim().toLocaleLowerCase() === 'slotlock');
  const unassigned = prepared.filter((template) => !template.playerId && template.game.trim().toLocaleLowerCase() !== 'slotlock');
  const updateSlotLock = (player: Player, patch: Partial<SlotLockControllerConfig>) => {
    const existing = state.slotLockControllers.find((config) => config.playerId === player.id)
      ?? createSlotLockConfig(player, [...prepared.map((template) => template.resolvedSlotName), ...state.slotLockControllers.map((config) => config.slotName)]);
    const next = { ...existing, ...patch, apValidation: undefined };
    patchState({ slotLockControllers: [...state.slotLockControllers.filter((config) => config.playerId !== player.id), next] });
  };
  return <div className="build-view">
    <div className="session-heading">
      <div><input className="session-name" value={state.sessionName} onChange={(event) => patchState({ sessionName: event.target.value })} aria-label="Session name" /><textarea value={state.sessionNotes} onChange={(event) => patchState({ sessionNotes: event.target.value })} placeholder="Add session notes..." aria-label="Session notes" /></div>
      <div className="session-summary">{state.presets.length > 0 && <select className="preset-select" defaultValue="" onChange={(event) => { loadPreset(event.target.value); event.target.value = ''; }} aria-label="Load session preset"><option value="" disabled>Load preset...</option>{state.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>}<IconButton label="Save session preset" onClick={savePreset}><Save size={16} /></IconButton><span><strong>{playerCount}</strong> players</span><span><strong>{sessionPrepared.length}</strong> slots</span><span><strong>{new Set(sessionPrepared.map((item) => item.game)).size}</strong> games</span><StatusChip tone={ready ? 'good' : 'warn'}>{ready ? 'Ready to generate' : 'Needs attention'}</StatusChip></div>
    </div>
    <div className="build-grid">
      <section className="workspace-panel library-panel">
        <div className="panel-heading"><div><Library size={17} /><strong>YAML Library</strong></div><IconButton label="Import YAML templates" onClick={importYaml}><FilePlus2 size={17} /></IconButton></div>
        <label className="search-field"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search games or players" /></label>
        <div className="template-list">
          {shown.length === 0 ? <EmptyState icon={FileCode2} title="No templates yet" action="Import YAML" onAction={importYaml} /> : shown.map((template) => <label className={`template-row ${state.selectedIds.includes(template.id) ? 'selected' : ''}`} key={template.id}>
            <input type="checkbox" checked={state.selectedIds.includes(template.id)} onChange={() => toggleTemplate(template.id)} />
            <span className="custom-check"><Check size={12} /></span>
            <span className="game-token">{template.game.slice(0, 2).toUpperCase()}</span>
            <span className="template-copy"><strong>{template.game}</strong><span>{template.description} · {template.slotName}</span></span>
            {hasGameSettings(template.game, template.worldMatch?.candidates.map((candidate) => candidate.id) ?? []) && <button className="icon-button template-settings-button" title={`${template.game} client settings`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); openGameSettings({ game: template.game, worldIds: template.worldMatch?.candidates.map((candidate) => candidate.id) ?? [] }); }}><SlidersHorizontal size={14} /></button>}
            {template.errors.length || ['Missing', 'Installed but incompatible', 'Ambiguous'].includes(template.worldMatch?.status ?? '') || templateValidationStatus(template, validationContextFingerprint) === 'Rejected' ? <CircleAlert className="error-icon" size={16} /> : templateValidationStatus(template, validationContextFingerprint) === 'Valid' ? <CheckCircle2 className="success-icon" size={16} /> : <CircleAlert className="warning-icon" size={16} />}
          </label>)}
        </div>
        <button className="library-link" onClick={() => setView('library')}>Manage template library <ExternalLink size={14} /></button>
      </section>
      <section className="workspace-panel validation-panel">
        <div className="panel-heading"><div><ListChecks size={17} /><strong>Preflight</strong></div>{running === 'validating' ? <button className="text-button" onClick={cancelValidation}><Square size={14} />Cancel {validationProgress ? `${validationProgress.index}/${validationProgress.total}` : ''}</button> : <button className="text-button" disabled={running !== 'idle' || !selected.length} onClick={dryRun}><RefreshCcw size={15} />Run AP check</button>}</div>
        <div className="readiness-list">{readiness.map((item) => <div className="readiness-row" key={item.label}>{item.ok ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}<div><strong>{item.label}</strong><span>{item.detail}</span></div></div>)}</div>
        <div className="subsection-heading"><strong>Working copy preview</strong><span>{prepared.filter((item) => item.changed).length} changes</span></div>
        <div className="diff-list">
          {sessionPrepared.length === 0 ? <div className="compact-empty">Select templates to preview slot names.</div> : sessionPrepared.map((item) => <div className="diff-row" key={item.id}><span className="game-token small">{item.game.slice(0, 2).toUpperCase()}</span><div><strong>{item.sourceSlotName}</strong>{item.changed && <><span className="arrow">→</span><strong className="resolved">{item.resolvedSlotName}</strong></>}</div>{item.id.startsWith('slotlock-controller:') ? <StatusChip tone="neutral">Generated</StatusChip> : item.changed ? <StatusChip tone="warn">Copy changed</StatusChip> : <StatusChip tone="good">Unchanged</StatusChip>}</div>)}
        </div>
        <div className="source-protection"><Archive size={17} /><span><strong>Source templates stay untouched.</strong> Changes are written only to session working copies.</span></div>
      </section>
      <section className="workspace-panel controls-panel">
        <div className="panel-heading"><div><SettingsIcon size={17} /><strong>Host & Generation</strong></div><StatusChip tone={rawHostError ? 'bad' : 'good'}>{rawHostError ? 'Invalid YAML' : 'Valid'}</StatusChip></div>
        <div className="host-summary"><div><span>Listen on</span><strong>{state.host.host || 'Archipelago default'}:{state.host.port}</strong></div><div><span>Passwords</span><strong>{state.host.roomPasswordSet ? 'Room protected' : 'Open room'} · {state.host.serverPasswordSet ? 'Remote admin on' : 'Remote admin off'}</strong></div><div><span>Runtime</span><strong>{state.host.logLevel} logs · {state.host.autoShutdown ? `${state.host.autoShutdown}s shutdown` : 'No auto shutdown'}</strong></div></div>
        <button className="server-settings-link" onClick={() => setView('server')}><SlidersHorizontal size={16} /><span><strong>Server Settings</strong><small>Server policy, generation, and shared client options</small></span><ChevronRight size={15} /></button>
        <div className="generation-actions"><button className="primary-button generate" disabled={!ready || running !== 'idle'} onClick={generate}>{running === 'generating' ? <LoaderCircle className="spin" size={18} /> : <WandSparkles size={18} />}Generate session</button><div><button className="secondary-button" disabled={!outputRoot} onClick={() => window.archipelago?.reveal(outputRoot)}><FolderOpen size={16} />Output</button><button className="secondary-button" onClick={() => window.archipelago?.openExternal(state.settings.launchUrl)}><ExternalLink size={16} />Launch site</button></div></div>
      </section>
    </div>
    <section className="slotlock-section">
      <div className="slotlock-heading"><div><LockKeyhole size={18} /><span><strong>SlotLock controllers</strong><small>Bind each player's selected games using their final working-copy slot names.</small></span></div><div className="slotlock-heading-actions"><StatusChip tone={slotLockWorldMatch?.status === 'Installed' || slotLockWorldMatch?.status === 'Installed with override' ? 'good' : 'warn'}>{slotLockWorldMatch?.status ?? 'Checking APWorld'}</StatusChip>{slotLockWorldMatch && !['Installed', 'Installed with override'].includes(slotLockWorldMatch.status) && <button className="secondary-button" onClick={() => setView('apworlds')}><PackageSearch size={14} />Manage APWorld</button>}</div></div>
      {targetGroups.length === 0 ? <div className="compact-empty">Assign selected game templates to roster players to configure SlotLock.</div> : <div className="slotlock-list">{targetGroups.map(({ player, templates }) => {
        const config = state.slotLockControllers.find((item) => item.playerId === player.id);
        const canEnable = Boolean(slotLockWorldMatch && ['Installed', 'Installed with override'].includes(slotLockWorldMatch.status));
        return <SlotLockControllerRow key={player.id} player={player} templates={templates} config={config} sources={sources} canEnable={canEnable} update={(patch) => updateSlotLock(player, patch)} />;
      })}</div>}
      {unassigned.length > 0 && <div className="slotlock-unassigned"><CircleAlert size={16} /><span><strong>{unassigned.length} selected YAML{unassigned.length === 1 ? ' is' : 's are'} unassigned</strong><small>{unassigned.map((template) => `${template.game}: ${template.resolvedSlotName}`).join(' · ')}</small></span><button className="secondary-button" onClick={() => setView('roster')}><UsersRound size={15} />Open roster</button></div>}
    </section>
  </div>;
}

function SlotLockControllerRow({ player, templates, config, sources, canEnable, update }: {
  player: Player;
  templates: ReturnType<typeof prepareTemplates>;
  config?: SlotLockControllerConfig;
  sources: Template[];
  canEnable: boolean;
  update: (patch: Partial<SlotLockControllerConfig>) => void;
}) {
  const included = (template: (typeof templates)[number]) => !config?.excludedTemplateIds.includes(template.id);
  const byGame = [...new Set(templates.map((template) => template.game))].map((game) => ({ game, templates: templates.filter((template) => template.game === game) }));
  const option = config?.options;
  const updateOption = (field: keyof NonNullable<typeof option>, value: number | boolean) => update({ options: { ...(option ?? createSlotLockConfig(player, []).options), [field]: value } });
  return <div className={`slotlock-row ${config?.enabled ? 'enabled' : ''}`}>
    <div className="slotlock-row-main">
      <label className="switch-control" title={!canEnable && !config?.enabled ? 'Install a compatible SlotLock APWorld first' : 'Enable SlotLock controller'}><input type="checkbox" checked={Boolean(config?.enabled)} disabled={!canEnable && !config?.enabled} onChange={(event) => update({ enabled: event.target.checked })} /><span /></label>
      <span className="avatar small">{player.name.slice(0, 2).toUpperCase()}</span>
      <span className="slotlock-player"><strong>{player.name}</strong><small>{templates.length} selected game slot{templates.length === 1 ? '' : 's'}</small></span>
      {config?.enabled ? <><label>Controller slot<input value={config.slotName} maxLength={16} onChange={(event) => update({ slotName: event.target.value })} /></label><label>Source<select value={config.sourceTemplateId ?? ''} onChange={(event) => { const source = sources.find((item) => item.id === event.target.value); update({ sourceTemplateId: source?.id, ...(source ? { options: hydrateSlotLockOptions(source.content) } : {}) }); }}><option value="">Automatic</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.description} · {source.slotName}</option>)}</select></label></> : <span className="slotlock-disabled-note">All games are included when enabled.</span>}
    </div>
    {config?.enabled && <div className="slotlock-details">
      <div className="slotlock-targets"><span className="form-label">Included games</span><div>{byGame.map(({ game, templates: gameTemplates }) => {
        const checked = gameTemplates.every(included);
        return <label key={game} title={gameTemplates.map((template) => template.resolvedSlotName).join(', ')}><input type="checkbox" checked={checked} onChange={(event) => {
          const ids = new Set(config.excludedTemplateIds);
          gameTemplates.forEach((template) => event.target.checked ? ids.delete(template.id) : ids.add(template.id));
          update({ excludedTemplateIds: [...ids] });
        }} /><span className="custom-check"><Check size={11} /></span><strong>{game}</strong><small>{gameTemplates.map((template) => template.resolvedSlotName).join(', ')}</small></label>;
      })}</div></div>
      <div className="slotlock-options"><span className="form-label">Common options</span><div className="slotlock-option-grid">
        <label>Starting unlocks<input type="number" min={0} max={Math.min(100, templates.filter(included).length)} value={option?.randomUnlockedSlots ?? 1} onChange={(event) => updateOption('randomUnlockedSlots', Number(event.target.value))} /></label>
        <label>Unlock copies<input type="number" min={1} max={10} value={option?.unlockItemCopies ?? 1} onChange={(event) => updateOption('unlockItemCopies', Number(event.target.value))} /></label>
        <label>Unlock filler<input type="number" min={0} max={9} value={option?.unlockItemFiller ?? 0} onChange={(event) => updateOption('unlockItemFiller', Number(event.target.value))} /></label>
        <label>Free-world items<input type="number" min={0} max={10} value={option?.freeUnlockedWorldItems ?? 0} onChange={(event) => updateOption('freeUnlockedWorldItems', Number(event.target.value))} /></label>
        <label>Bonus slots<input type="number" min={0} max={1000} value={option?.bonusItemSlots ?? 0} onChange={(event) => updateOption('bonusItemSlots', Number(event.target.value))} /></label>
        <label>Bonus copies<input type="number" min={1} max={10} value={option?.bonusItemCopies ?? 1} onChange={(event) => updateOption('bonusItemCopies', Number(event.target.value))} /></label>
        <label>Bonus filler<input type="number" min={0} max={9} value={option?.bonusItemFiller ?? 0} onChange={(event) => updateOption('bonusItemFiller', Number(event.target.value))} /></label>
      </div><div className="slotlock-checks"><label><input type="checkbox" checked={option?.freeStartingItems ?? false} onChange={(event) => updateOption('freeStartingItems', event.target.checked)} />Free starting items</label><label><input type="checkbox" checked={option?.autoHintLockedItems ?? false} onChange={(event) => updateOption('autoHintLockedItems', event.target.checked)} />Automatic hints</label></div></div>
    </div>}
  </div>;
}

function TemplateLibrary({ templates, players, importYaml, importFolder, sourcePath, updateTemplate, remove, validate, cancelValidation, validationProgress, validating, findApWorld, hasGameSettings, openGameSettings, notify }: {
  templates: Template[]; players: Player[]; importYaml: () => void; importFolder: () => void; sourcePath: string;
  updateTemplate: (id: string, patch: Partial<Template>) => void; remove: (id: string) => void;
  validate: (templates: Template[]) => void; cancelValidation: () => void; validationProgress?: ApYamlValidationProgress;
  validating: boolean; findApWorld: (game: string) => void; hasGameSettings: (game: string, worldIds?: string[]) => boolean; openGameSettings: (target: GameSettingsTarget) => void; notify: (message: string) => void;
}) {
  const copyValidation = async (template: Template) => {
    await navigator.clipboard.writeText(template.apValidation?.output || template.apValidation?.message || 'No AP validation output.');
    notify('Validation details copied');
  };
  const worldTone = (template: Template) => template.worldMatch?.status === 'Installed' ? 'good' : template.worldMatch?.status === 'Missing' || template.worldMatch?.status === 'Installed but incompatible' ? 'bad' : 'warn';
  const validationTone = (status: ReturnType<typeof templateValidationStatus>) => status === 'Valid' ? 'good' : status === 'Rejected' ? 'bad' : 'warn';
  return <div className="page-view"><div className="page-heading"><div><h1>Template Library</h1><p>{templates.length} curated player files across {new Set(templates.map((item) => item.game)).size} games</p></div><div className="heading-actions">
    {validating ? <button className="secondary-button" onClick={cancelValidation}><Square size={14} />Cancel {validationProgress ? `${validationProgress.index}/${validationProgress.total}` : ''}</button> : <button className="secondary-button" disabled={!templates.length} onClick={() => validate(templates)}><ListChecks size={15} />Validate all</button>}
    <button className="secondary-button" title={sourcePath} onClick={importFolder}><FolderOpen size={16} />Import source folder</button><button className="primary-button" onClick={importYaml}><FilePlus2 size={17} />Import YAML</button>
  </div></div>
    {templates.length === 0 ? <EmptyState icon={Library} title="Your library is empty" action="Import YAML" onAction={importYaml} /> : <><div className="cleanup-summary"><WandSparkles size={16} /><span><strong>Import cleanup</strong>{templates.some((item) => item.errors.some((error) => error.startsWith('Filename should'))) ? `${templates.filter((item) => item.errors.some((error) => error.startsWith('Filename should'))).length} filename suggestions ready` : 'Naming and categories are tidy'}</span></div><div className="data-table"><div className="table-head"><span>Template</span><span>Player / slot</span><span>Filename</span><span>Last used</span><span>Status</span><span /></div>{templates.map((template) => {
      const validationStatus = templateValidationStatus(template);
      const isChecking = validating && validationProgress?.templateId === template.id && validationProgress.state === 'checking';
      const worldIds = template.worldMatch?.candidates.map((candidate) => candidate.id) ?? [];
      return <div className="table-row" key={template.id}>
        <span className="template-cell"><span className="game-token">{template.game.slice(0, 2).toUpperCase()}</span><span><strong>{template.game}</strong><input className="description-editor" value={template.description} onChange={(event) => updateTemplate(template.id, { description: event.target.value })} aria-label={`Description for ${template.game}`} title="Template label" /></span></span>
        <span className="player-slot-cell"><select value={template.playerId ?? ''} onChange={(event) => { const player = players.find((item) => item.id === event.target.value); updateTemplate(template.id, { playerId: player?.id, slotName: player ? player.preferredSlot || player.name : template.slotName }); }} aria-label={`Roster player for ${template.game}`}><option value="">Auto-match</option>{players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select><input className="slot-editor" value={template.slotName} onChange={(event) => updateTemplate(template.id, { slotName: event.target.value })} aria-label={`Slot name for ${template.game}`} /></span>
        <span className="file-name-cell"><code>{template.fileName}</code>{template.errors.some((error) => error.startsWith('Filename should')) && <small>Suggested: {suggestedFileName(template)}</small>}</span><span>{formatDate(template.lastUsed)}</span>
        <span className="template-statuses" title={`${template.worldMatch?.message || 'World match pending'}\n${template.apValidation?.message || 'AP options not checked'}`}>
          {template.errors.length ? <StatusChip tone="bad">{template.errors.length} YAML issues</StatusChip> : <StatusChip tone="good">YAML parsed</StatusChip>}
          {template.worldMatch?.status === 'Missing' ? <button className="chip-button" title={template.worldMatch.message} onClick={() => findApWorld(template.worldMatch?.suggestion || template.game)}><StatusChip tone={worldTone(template)}>{template.worldMatch.suggestion ? `Missing · ${template.worldMatch.suggestion}?` : 'Missing'}</StatusChip></button> : <StatusChip tone={worldTone(template)}>{template.worldMatch?.status ?? 'Checking world'}</StatusChip>}
          <StatusChip tone={validationTone(validationStatus)}>{isChecking ? 'Checking options' : validationStatus}</StatusChip>
        </span>
        <span className="template-actions">{hasGameSettings(template.game, worldIds) && <IconButton label={`${template.game} client settings`} onClick={() => openGameSettings({ game: template.game, worldIds })}><SlidersHorizontal size={15} /></IconButton>}<IconButton label={`Validate ${template.fileName}`} onClick={() => validate([template])}>{isChecking ? <LoaderCircle className="spin" size={15} /> : <ListChecks size={15} />}</IconButton>{template.apValidation && <IconButton label={`Copy validation details for ${template.fileName}`} onClick={() => void copyValidation(template)}><Clipboard size={15} /></IconButton>}<IconButton label={`Remove ${template.fileName}`} danger onClick={() => remove(template.id)}><Trash2 size={16} /></IconButton></span>
      </div>;
    })}</div></>}
  </div>;
}

function Roster({ players, templates, selectedIds, setPlayers, assignTemplate, toggleTemplate, selectPlayerTemplates, exportTemplate, exportPack }: {
  players: Player[]; templates: Template[]; selectedIds: string[]; setPlayers: (players: Player[]) => void;
  assignTemplate: (templateId: string, playerId: string, mode: 'copy' | 'move') => void;
  toggleTemplate: (templateId: string) => void; selectPlayerTemplates: (player: Player) => void;
  exportTemplate: (template: Template, player: Player) => void; exportPack: (player: Player) => void;
}) {
  const [sourceChoices, setSourceChoices] = useState<Record<string, string>>({});
  const [transferTargets, setTransferTargets] = useState<Record<string, string>>({});
  const add = () => setPlayers([...players, { id: crypto.randomUUID(), name: 'New player', preferredSlot: '', note: '' }]);
  const update = (id: string, patch: Partial<Player>) => setPlayers(players.map((player) => player.id === id ? { ...player, ...patch } : player));
  return <div className="page-view"><div className="page-heading"><div><h1>Player Roster</h1><p>Recurring players and their preferred slot names</p></div><button className="primary-button" onClick={add}><UserRound size={17} />Add player</button></div>
    {players.length === 0 ? <EmptyState icon={UsersRound} title="No recurring players" action="Add player" onAction={add} /> : <div className="roster-grid">{players.map((player) => {
      const assigned = templates.filter((template) => playerIdentity(template, players) === `roster:${player.id}`);
      const selectedForPlayer = assigned.filter((template) => selectedIds.includes(template.id)).length;
      const sourceId = sourceChoices[player.id] ?? templates[0]?.id ?? '';
      return <article className="roster-card" key={player.id}>
        <div className="avatar">{player.name.slice(0, 2).toUpperCase()}</div>
        <div className="roster-fields"><span className="roster-name"><input value={player.name} onChange={(event) => update(player.id, { name: event.target.value })} aria-label="Player name" /><StatusChip tone={assigned.length ? 'good' : 'neutral'}>{assigned.length} games</StatusChip></span><label>Preferred slot<input value={player.preferredSlot} onChange={(event) => update(player.id, { preferredSlot: event.target.value })} placeholder="Same as player" /></label><label>Notes<input value={player.note} onChange={(event) => update(player.id, { note: event.target.value })} placeholder="Optional" /></label></div>
        <IconButton label={`Remove ${player.name}`} danger onClick={() => setPlayers(players.filter((item) => item.id !== player.id))}><X size={17} /></IconButton>
        <div className="loadout-section">
          <div className="loadout-heading"><div><strong>Game loadout</strong><span>{selectedForPlayer} of {assigned.length} selected</span></div><div><button className="text-button" disabled={!assigned.length} onClick={() => selectPlayerTemplates(player)}><ListChecks size={15} />Select games</button><button className="secondary-button" disabled={!assigned.length} onClick={() => exportPack(player)}><Download size={15} />Export YAMLs</button></div></div>
          <div className="loadout-list">{assigned.length === 0 ? <div className="compact-empty">No games assigned.</div> : assigned.map((template) => {
            const targetId = transferTargets[template.id] ?? players.find((item) => item.id !== player.id)?.id ?? '';
            return <div className="loadout-row" key={template.id}><label className="loadout-select"><input type="checkbox" checked={selectedIds.includes(template.id)} onChange={() => toggleTemplate(template.id)} /><span className="custom-check"><Check size={12} /></span></label><span className="game-token small">{template.game.slice(0, 2).toUpperCase()}</span><span className="loadout-title"><strong>{template.game}</strong><small>{template.description} · {template.slotName}</small></span><IconButton label={`Export ${template.game} YAML`} onClick={() => exportTemplate(template, player)}><Download size={15} /></IconButton>{players.length > 1 && <span className="transfer-controls"><select value={targetId} onChange={(event) => setTransferTargets((current) => ({ ...current, [template.id]: event.target.value }))} aria-label={`Transfer ${template.game} to player`}>{players.filter((item) => item.id !== player.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><IconButton label={`Copy ${template.game} to selected player`} onClick={() => targetId && assignTemplate(template.id, targetId, 'copy')}><Copy size={15} /></IconButton><IconButton label={`Move ${template.game} to selected player`} onClick={() => targetId && assignTemplate(template.id, targetId, 'move')}><ArrowRightLeft size={15} /></IconButton></span>}</div>;
          })}</div>
          {templates.length > 0 && <div className="add-loadout"><select value={sourceId} onChange={(event) => setSourceChoices((current) => ({ ...current, [player.id]: event.target.value }))} aria-label={`Choose game for ${player.name}`}>{templates.map((template) => <option key={template.id} value={template.id}>{template.game} · {template.description} · {template.slotName}</option>)}</select><button className="secondary-button" disabled={!sourceId} onClick={() => assignTemplate(sourceId, player.id, 'copy')}><Copy size={15} />Copy here</button><button className="secondary-button" disabled={!sourceId} onClick={() => assignTemplate(sourceId, player.id, 'move')}><ArrowRightLeft size={15} />Move here</button></div>}
        </div>
      </article>;
    })}</div>}
  </div>;
}

function HistoryView({ history, rooms, cloneRun, hostRun, adoptRoom, reveal, openBuild, refreshHistory }: { history: HistoryRun[]; rooms: ManagedRoom[]; cloneRun: (run: HistoryRun) => void; hostRun: (run: HistoryRun) => void; adoptRoom: (run: HistoryRun) => void; reveal: (path: string) => unknown; openBuild: () => void; refreshHistory: () => void }) {
  return <div className="page-view"><div className="page-heading"><div><h1>Session History</h1><p>Generated sessions, logs, and recovery actions</p></div><button className="secondary-button" onClick={refreshHistory}><RefreshCcw size={16} />Import existing</button></div>
    {history.length === 0 ? <EmptyState icon={History} title="No sessions generated yet" action="Open session build" onAction={openBuild} /> : <div className="history-list">{history.map((run) => { const roomExists = rooms.some((room) => room.provider?.type === 'local' && room.provider.historyRunId === run.id); return <article className="history-row" key={run.id}><div className={`history-state ${run.status}`}><Clock3 size={18} /></div><div className="history-main"><div><strong>{run.name}</strong><StatusChip tone={run.status === 'generated' ? 'good' : 'bad'}>{run.status}</StatusChip>{roomExists && <StatusChip tone="neutral">Room ready</StatusChip>}</div><span>{formatDate(run.createdAt)} · {run.playerCount || 'Unknown'} players · {run.slotCount || 'Unknown'} slots{run.games.length ? ` · ${run.games.join(', ')}` : ''}</span>{run.slots?.length ? <small className="history-slots">{run.slots.map((slot) => `${slot.game}: ${slot.name}`).join(' · ')}</small> : <small>{run.notes || 'No session notes'}</small>}</div><div className="history-actions">{run.slots?.length ? <IconButton label="Copy game connection slots" onClick={() => void navigator.clipboard.writeText(run.slots!.map((slot) => `${slot.game}: ${slot.name}`).join('\n'))}><Clipboard size={16} /></IconButton> : null}<IconButton label="Open output folder" onClick={() => reveal(run.outputPath)}><FolderOpen size={17} /></IconButton><button className="secondary-button" disabled={!run.templateIds.length} onClick={() => cloneRun(run)}><Copy size={15} />Clone</button>{!roomExists && <button className="secondary-button" disabled={run.status !== 'generated' || !run.slots?.length} onClick={() => adoptRoom(run)}><Link size={15} />Create room</button>}<button className="secondary-button" disabled={run.status !== 'generated'} onClick={() => hostRun(run)}><Play size={15} />Host</button></div></article>; })}</div>}
  </div>;
}

type ToolInventory = {
  programs: Array<{ name: string; path: string }>;
  worlds: Array<{ name: string; path: string }>;
  components: Array<{ displayName: string; type: string; sourceWorld: string; origin: 'custom' | 'built-in' }>;
};

function ToolsView({ settings, refreshTemplates, notify, openApWorlds }: { settings: AppState['settings']; refreshTemplates: () => void; notify: (message: string) => void; openApWorlds: () => void }) {
  const [inventory, setInventory] = useState<ToolInventory>({ programs: [], worlds: [], components: [] });
  const [trackerAvailability, setTrackerAvailability] = useState({ pop: false, emo: false });

  const refreshInventory = async () => {
    const result = await window.archipelago?.inventoryTools(settings.installRoot);
    if (result) setInventory(result);
  };

  useEffect(() => {
    void refreshInventory();
    void Promise.all([window.archipelago?.exists(settings.popTrackerPath) ?? false, window.archipelago?.exists(settings.emoTrackerPath) ?? false]).then(([pop, emo]) => setTrackerAvailability({ pop, emo }));
    // Tool discovery is intentionally refreshed when the configured installation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.installRoot, settings.popTrackerPath, settings.emoTrackerPath]);

  const find = (name: string) => inventory.programs.find((program) => program.name === name);
  const launch = async (name: string) => {
    const program = find(name);
    if (!program) return;
    const result = await window.archipelago?.launchTool(program.path);
    notify(result?.ok ? `${name.replace(/^Archipelago|\.exe$/g, '')} opened` : result?.error ?? 'Tool could not be opened');
  };
  const integrated = new Set(['ArchipelagoGenerate.exe', 'ArchipelagoServer.exe']);
  const workflow = new Set(['ArchipelagoOptionsCreator.exe', 'ArchipelagoTextClient.exe', 'ArchipelagoChecksFinderClient.exe']);
  const hidden = new Set(['ArchipelagoLauncher.exe', 'ArchipelagoLauncherDebug.exe']);
  const clients = inventory.programs.filter((program) => !integrated.has(program.name) && !workflow.has(program.name) && !hidden.has(program.name));
  const label = (name: string) => name.replace(/^Archipelago/, '').replace(/\.exe$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const launchExternal = async (name: string, executable: string) => {
    const result = await window.archipelago?.launchTool(executable);
    notify(result?.ok ? `${name} opened` : result?.error ?? `${name} could not be opened`);
  };
  const launchComponent = async (displayName: string) => {
    const result = await window.archipelago?.launchApWorldComponent({ installRoot: settings.installRoot, displayName });
    notify(result?.ok ? `${displayName} opened` : result?.error ?? `${displayName} could not be opened`);
  };
  const openPatch = async () => {
    const result = await window.archipelago?.openPatch(settings.installRoot);
    if (result?.canceled) return;
    notify(result?.ok ? 'Patch handed to Archipelago' : result?.error ?? 'Patch could not be opened');
  };

  return <div className="page-view tools-view">
    <div className="page-heading"><div><h1>Archipelago Tools</h1><p>{inventory.programs.length} installed programs · {inventory.components.length} APWorld tools · {inventory.worlds.length} custom APWorlds</p></div><div className="tool-actions"><IconButton label="Refresh tool inventory" onClick={() => void refreshInventory()}><RefreshCcw size={16} /></IconButton><StatusChip tone={inventory.programs.length ? 'good' : 'bad'}>{inventory.programs.length ? 'Installation detected' : 'Not found'}</StatusChip></div></div>
    <section className="tool-section"><div className="tool-section-heading"><WandSparkles size={18} /><div><strong>Built into Controller</strong><span>Used directly by session generation and local hosting</span></div></div><div className="tool-list"><div className="tool-row"><span><strong>Generator</strong><small>Preflight, working-copy generation, and output unpacking</small></span><StatusChip tone={find('ArchipelagoGenerate.exe') ? 'good' : 'bad'}>{find('ArchipelagoGenerate.exe') ? 'Integrated' : 'Missing'}</StatusChip></div><div className="tool-row"><span><strong>Server</strong><small>Managed local hosting, saved progress, logs, and stop control</small></span><StatusChip tone={find('ArchipelagoServer.exe') ? 'good' : 'bad'}>{find('ArchipelagoServer.exe') ? 'Integrated' : 'Missing'}</StatusChip></div></div></section>
    <section className="tool-section"><div className="tool-section-heading"><FileCode2 size={18} /><div><strong>Session Workflow</strong><span>Focused Archipelago utilities available without the launcher</span></div></div><div className="tool-list"><div className="tool-row"><span><strong>Open Patch</strong><small>Open a generated patch or game file with its registered APWorld handler</small></span><button className="secondary-button" disabled={!find('ArchipelagoLauncher.exe')} onClick={() => void openPatch()}><FilePlus2 size={15} />Choose file</button></div><div className="tool-row"><span><strong>YAML Options Creator</strong><small>Create templates from installed games and APWorlds</small></span><div className="tool-actions"><button className="secondary-button" disabled={!find('ArchipelagoOptionsCreator.exe')} onClick={() => launch('ArchipelagoOptionsCreator.exe')}><ExternalLink size={15} />Open</button><button className="secondary-button" onClick={refreshTemplates}><RefreshCcw size={15} />Refresh library</button></div></div><div className="tool-row"><span><strong>Text Client</strong><small>Connect to a hosted room for chat and text-only slot control</small></span><button className="secondary-button" disabled={!find('ArchipelagoTextClient.exe')} onClick={() => launch('ArchipelagoTextClient.exe')}><ExternalLink size={15} />Open</button></div><div className="tool-row"><span><strong>Checks Finder</strong><small>Launch the dedicated Checks Finder client</small></span><button className="secondary-button" disabled={!find('ArchipelagoChecksFinderClient.exe')} onClick={() => launch('ArchipelagoChecksFinderClient.exe')}><ExternalLink size={15} />Open</button></div><div className="tool-row"><span><strong>Full Archipelago Launcher</strong><small>Fallback for components that do not publish discoverable metadata</small></span><button className="secondary-button" disabled={!find('ArchipelagoLauncher.exe')} onClick={() => launch('ArchipelagoLauncher.exe')}><ExternalLink size={15} />Open</button></div></div></section>
    {(settings.popTrackerPath || settings.emoTrackerPath) && <section className="tool-section"><div className="tool-section-heading"><Gamepad2 size={18} /><div><strong>External Trackers</strong><span>Configured companion applications</span></div></div><div className="tool-list">{settings.popTrackerPath && <div className="tool-row"><span><strong>PopTracker</strong><small>{settings.popTrackerPath}</small></span><StatusChip tone={trackerAvailability.pop ? 'good' : 'bad'}>{trackerAvailability.pop ? 'Available' : 'Missing'}</StatusChip><button className="secondary-button" disabled={!trackerAvailability.pop} onClick={() => void launchExternal('PopTracker', settings.popTrackerPath)}><ExternalLink size={15} />Open</button></div>}{settings.emoTrackerPath && <div className="tool-row"><span><strong>EmoTracker</strong><small>{settings.emoTrackerPath}</small></span><StatusChip tone={trackerAvailability.emo ? 'good' : 'bad'}>{trackerAvailability.emo ? 'Available' : 'Missing'}</StatusChip><button className="secondary-button" disabled={!trackerAvailability.emo} onClick={() => void launchExternal('EmoTracker', settings.emoTrackerPath)}><ExternalLink size={15} />Open</button></div>}</div></section>}
    <section className="tool-section"><div className="tool-section-heading"><PackageSearch size={18} /><div><strong>APWorld Tools</strong><span>Trackers and clients registered by installed worlds</span></div></div>{inventory.components.length ? <div className="client-grid">{inventory.components.map((component) => <button key={`${component.sourceWorld}:${component.displayName}`} className="client-tool component-tool" onClick={() => void launchComponent(component.displayName)} title={`${component.displayName} · ${component.sourceWorld}`}><Gamepad2 size={16} /><span><strong>{component.displayName}</strong><small>{component.sourceWorld}{component.origin === 'custom' ? ' · Custom' : ''}</small></span><ExternalLink size={13} /></button>)}</div> : <div className="tool-list"><div className="tool-row"><span><strong>No registered APWorld tools found</strong><small>Refresh after installing or updating a world</small></span></div></div>}</section>
    <section className="tool-section"><div className="tool-section-heading"><Gamepad2 size={18} /><div><strong>Clients & Adjusters</strong><span>Specialized programs that retain their native interfaces</span></div></div><div className="client-grid">{clients.map((program) => <button key={program.name} className="client-tool" onClick={() => launch(program.name)}><Gamepad2 size={16} /><span>{label(program.name)}</span><ExternalLink size={13} /></button>)}</div></section>
    <section className="tool-section"><div className="tool-section-heading"><Archive size={18} /><div><strong>Custom APWorlds</strong><span>Available to the generator and YAML Options Creator</span></div></div><div className="tool-list"><div className="tool-row"><span><strong>{inventory.worlds.length} installed APWorld{inventory.worlds.length === 1 ? '' : 's'}</strong><small>{inventory.worlds.map((world) => world.name).join(' · ') || 'No custom worlds installed'}</small></span><button className="secondary-button" onClick={openApWorlds}><PackageSearch size={15} />Manage</button></div></div></section>
  </div>;
}

function SettingsView({ state, patchState, brokerState, apUpdate, checkingApUpdate, checkArchipelagoUpdate, openArchipelagoUpdate }: { state: AppState; patchState: (patch: Partial<AppState>) => void; brokerState?: RoomBrokerState; apUpdate?: ArchipelagoUpdateStatus; checkingApUpdate: boolean; checkArchipelagoUpdate: () => void; openArchipelagoUpdate: () => void }) {
  const update = (key: keyof AppState['settings'], value: string | boolean | number) => {
    if (key !== 'installRoot') {
      patchState({ settings: { ...state.settings, [key]: value } });
      return;
    }
    const settings = { ...state.settings, installRoot: String(value) };
    for (const pathKey of mainRelativeSettings) settings[pathKey] = tokenizeMainPath(state.settings[pathKey], state.settings.installRoot);
    patchState({ settings });
  };
  const choose = async (key: keyof AppState['settings'], kind: 'file' | 'directory', title: string) => {
    const value = kind === 'file' ? await window.archipelago?.pickExecutable(title) : await window.archipelago?.pickDirectory(title);
    if (value) update(key, mainRelativeSettings.includes(key as typeof mainRelativeSettings[number]) ? tokenizeMainPath(value, state.settings.installRoot) : value);
  };
  const configureHostApiKey = async (remove = false) => {
    const secretRef = state.settings.roomHostApiKeyRef || 'room-host-api-key';
    const result = await window.archipelago?.configureRoomHostApiKey({ secretRef, remove });
    if (!result || result.error) return;
    if (result.key) await navigator.clipboard.writeText(result.key);
    patchState({ settings: { ...state.settings, roomHostApiKeyRef: secretRef, roomHostApiKeySet: Boolean(result.configured) } });
  };
  return <div className="page-view settings-view"><div className="page-heading"><div><h1>Settings</h1><p>Archipelago tools, storage, and generation defaults</p></div><StatusChip tone={electronReady ? 'good' : 'warn'}>{electronReady ? 'Desktop bridge active' : 'Browser preview'}</StatusChip></div>
    <section className="settings-section"><div><Server size={19} /><span><strong>Archipelago tools</strong><small>Generator, server, clients, and APWorlds are discovered here</small></span></div><div className="settings-fields"><PathField label="Installation folder" value={state.settings.installRoot} onChange={(value) => update('installRoot', value)} onBrowse={() => choose('installRoot', 'directory', 'Choose Archipelago installation')} /><div className="ap-version-row"><span><strong>Archipelago {apUpdate?.installedVersion ?? 'Unknown'}</strong><small>{apUpdate?.state === 'outdated' ? `${apUpdate.latestVersion} available` : apUpdate?.state === 'current' ? 'Latest stable release installed' : apUpdate?.state === 'ahead' ? 'Newer than the latest stable release' : apUpdate?.error || 'Release status has not been checked'}</small></span><div className="tool-actions"><button className="secondary-button" disabled={checkingApUpdate || !state.settings.installRoot} onClick={checkArchipelagoUpdate}>{checkingApUpdate ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />}Check now</button>{apUpdate?.state === 'outdated' && <button className="update-button" onClick={openArchipelagoUpdate}><Download size={15} />Update</button>}</div></div><label>Generator arguments<input value={state.settings.generatorArgs} onChange={(event) => update('generatorArgs', event.target.value)} /><small>Available placeholders: {'{input}'}, {'{output}'}, {'{root}'}</small></label></div></section>
    <section className="settings-section"><div><Gamepad2 size={19} /><span><strong>External trackers</strong><small>Configured programs appear as buttons on the Tools screen</small></span></div><div className="settings-fields"><PathField label="PopTracker executable" value={state.settings.popTrackerPath} onChange={(value) => update('popTrackerPath', value)} onBrowse={() => choose('popTrackerPath', 'file', 'Choose PopTracker executable')} /><PathField label="EmoTracker executable" value={state.settings.emoTrackerPath} onChange={(value) => update('emoTrackerPath', value)} onBrowse={() => choose('emoTrackerPath', 'file', 'Choose EmoTracker executable')} /></div></section>
    <section className="settings-section"><div><Globe2 size={19} /><span><strong>Public room sharing</strong><small>Optional HTTPS gateway for browser and Controller invitations</small></span></div><div className="settings-fields gateway-settings"><label>Gateway<select value={state.settings.roomGatewayMode} onChange={(event) => update('roomGatewayMode', event.target.value)}><option value="local">Local only</option><option value="managed">Managed HTTPS</option><option value="external">External HTTPS proxy</option><option value="direct">Direct HTTP</option></select><small>{state.settings.roomGatewayMode === 'managed' ? 'Controller runs its bundled HTTPS gateway and renews the certificate.' : state.settings.roomGatewayMode === 'external' ? 'An existing reverse proxy or tunnel forwards to the room portal.' : state.settings.roomGatewayMode === 'direct' ? 'Public traffic is unencrypted and requires confirmation for every room.' : 'Public invitations are unavailable; local hosting still works.'}</small></label>{state.settings.roomGatewayMode === 'managed' && <><label>Public hostname<input value={state.settings.roomGatewayHostname} onChange={(event) => update('roomGatewayHostname', event.target.value.trim())} placeholder="rooms.example.net" /><small>DNS must resolve to this computer's public connection.</small></label><label>Certificate contact email<input type="email" value={state.settings.roomGatewayEmail} onChange={(event) => update('roomGatewayEmail', event.target.value.trim())} placeholder="host@example.net" /><small>Used only for ACME certificate registration and expiry notices.</small></label></>}{state.settings.roomGatewayMode === 'external' && <label>Public HTTPS URL<input type="url" value={state.settings.roomGatewayPublicUrl} onChange={(event) => update('roomGatewayPublicUrl', event.target.value.trim())} placeholder="https://rooms.example.net" /><small>The proxy must forward this origin to the configured room portal port.</small></label>}</div></section>
    <section className="settings-section"><div><LockKeyhole size={19} /><span><strong>Room data API</strong><small>One normalized API for every saved official, local, and Controller room</small></span></div><div className="settings-fields"><div className="ap-version-row"><span><strong>{brokerState?.running ? 'API online' : state.settings.roomDataApiEnabled ? 'API unavailable' : 'API disabled'}</strong><small>{brokerState?.error || `http://127.0.0.1:${state.settings.roomDataApiPort}/api/controller/v2`}</small></span><div className="tool-actions"><StatusChip tone={brokerState?.running ? 'good' : state.settings.roomDataApiEnabled ? 'bad' : 'neutral'}>{brokerState?.running ? 'Running' : 'Stopped'}</StatusChip><button className="secondary-button" disabled={!brokerState?.running} onClick={() => void navigator.clipboard.writeText(`http://127.0.0.1:${state.settings.roomDataApiPort}/api/controller/v2`)}>Copy URL</button></div></div><label className="setting-checkbox"><input type="checkbox" checked={state.settings.roomDataApiEnabled} onChange={(event) => update('roomDataApiEnabled', event.target.checked)} /><span className="custom-check">{state.settings.roomDataApiEnabled && <Check size={11} />}</span>Run the Room data API while Controller is open</label><label>API port<input type="number" min={1} max={65535} value={state.settings.roomDataApiPort} onChange={(event) => update('roomDataApiPort', Math.min(65535, Math.max(1, Number(event.target.value) || 38283)))} /><small>The port stays fixed; Controller reports an error instead of silently changing it.</small></label><label className="setting-checkbox"><input type="checkbox" checked={state.settings.roomDataApiRemote} onChange={(event) => update('roomDataApiRemote', event.target.checked)} /><span className="custom-check">{state.settings.roomDataApiRemote && <Check size={11} />}</span>Allow authenticated Room API access outside this computer</label>{state.settings.roomDataApiRemote && <div className="room-error">Network API requests require the bearer key. Configure your firewall and port forwarding separately if internet access is intended.</div>}<label>Allowed browser origins<textarea rows={3} value={state.settings.roomDataApiAllowedOrigins} onChange={(event) => update('roomDataApiAllowedOrigins', event.target.value)} placeholder={'http://localhost:3000\nhttps://dashboard.example.net'} /><small>One exact HTTP or HTTPS origin per line. Leave blank to disable browser CORS.</small></label><label className="setting-checkbox"><input type="checkbox" checked={state.settings.allowSpoilerApi} onChange={(event) => update('allowSpoilerApi', event.target.checked)} /><span className="custom-check">{state.settings.allowSpoilerApi && <Check size={11} />}</span>Allow spoiler fields for non-race seeds when explicitly requested</label><div className="ap-version-row"><span><strong>Room API bearer key</strong><small>{state.settings.roomHostApiKeySet ? 'Encrypted with Windows secure storage. Required for actions and all network access.' : 'No key configured; refresh/wake actions and network access are disabled.'}</small></span><div className="tool-actions"><button className="secondary-button" onClick={() => void configureHostApiKey()}>{state.settings.roomHostApiKeySet ? 'Rotate & copy' : 'Generate & copy'}</button>{state.settings.roomHostApiKeySet && <button className="secondary-button" onClick={() => void configureHostApiKey(true)}>Remove</button>}</div></div></div></section>
    <section className="settings-section"><div><FolderOpen size={19} /><span><strong>Storage</strong><small>Use {'{main}'} for the installation or {'{hosted}'} for the hosted-session folder</small></span></div><div className="settings-fields"><PathField label="Current YAML source" value={state.settings.importSource} resolvedValue={resolveMainPath(state.settings.importSource, state.settings.installRoot)} onChange={(value) => update('importSource', value)} onBrowse={() => choose('importSource', 'directory', 'Choose YAML source folder')} /><PathField label="Managed template library" value={state.settings.libraryPath} resolvedValue={resolveMainPath(state.settings.libraryPath, state.settings.installRoot)} onChange={(value) => update('libraryPath', value)} onBrowse={() => choose('libraryPath', 'directory', 'Choose template library')} /><PathField label="Archipelago output" value={state.settings.outputRoot} resolvedValue={resolveMainPath(state.settings.outputRoot, state.settings.installRoot)} onChange={(value) => update('outputRoot', value)} onBrowse={() => choose('outputRoot', 'directory', 'Choose output folder')} /><PathField label="Hosted sessions" value={state.settings.hostedSessionsPath} resolvedValue={resolveMainPath(state.settings.hostedSessionsPath, state.settings.installRoot)} onChange={(value) => update('hostedSessionsPath', value)} onBrowse={() => choose('hostedSessionsPath', 'directory', 'Choose hosted sessions folder')} /><PathField label="Managed rooms" value={state.settings.roomsRoot} resolvedValue={resolveStoragePath(state.settings.roomsRoot, state.settings.installRoot, state.settings.hostedSessionsPath)} onChange={(value) => update('roomsRoot', value)} onBrowse={() => choose('roomsRoot', 'directory', 'Choose managed rooms folder')} /></div></section>
    <section className="settings-section"><div><ExternalLink size={19} /><span><strong>Launch site</strong><small>Remote hosting upload destination</small></span></div><div className="settings-fields"><label>URL<input type="url" value={state.settings.launchUrl} onChange={(event) => update('launchUrl', event.target.value)} /></label></div></section>
    <button className="secondary-button reset-button" onClick={() => patchState({ settings: initialState.settings })}><RefreshCcw size={16} />Restore defaults</button>
  </div>;
}

function PathField({ label, value, resolvedValue, onChange, onBrowse }: { label: string; value: string; resolvedValue?: string; onChange: (value: string) => void; onBrowse: () => void }) {
  return <label>{label}<span className="path-field"><input value={value} onChange={(event) => onChange(event.target.value)} placeholder="Not configured" /><IconButton label={`Browse for ${label}`} onClick={onBrowse}><FolderOpen size={16} /></IconButton></span>{resolvedValue && resolvedValue !== value && <small className="path-resolution">{resolvedValue}</small>}</label>;
}
