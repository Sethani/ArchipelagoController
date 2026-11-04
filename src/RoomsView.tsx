import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Check, CircleX, Clipboard, Download, ExternalLink, FilePlus2, FolderOpen, Gamepad2, Link, LoaderCircle,
  Globe2, Lightbulb, Map as MapIcon, MessageSquareText, Play, Plus, Power, Radar, RefreshCcw, Rocket, Search, Share2, SlidersHorizontal, Trash2, UsersRound, WandSparkles,
} from 'lucide-react';
import type { GameLaunchAction, GameLaunchProfile, HistoryRun, ManagedRoom, ManagedRoomSlot, MinecraftLauncherInventory, PopTrackerAssociation, PopTrackerPack, RemoteProfile, RoomLogicAnalysis, RoomShareStatus, RoomSphereSnapshot, RoomStatusSnapshot, RoomTrackerDashboard, Settings, Template } from './types';
import { emptyLaunchAction, emptyLaunchProfile, launchProfileKey, minecraftLaunchAction, previewLaunchTemplate, suggestLaunchTemplate } from './lib/gameLaunch';
import { validationFingerprint } from './lib/session';

type RoomInspection = RoomStatusSnapshot & {
  roomId: string;
  url: string;
  slots: Array<{ slot: number; name: string; game: string; downloadAvailable: boolean; remoteFiles?: import('./types').RoomRemoteFile[] }>;
  provider?: ManagedRoom['provider'];
};

type LauncherComponent = { displayName: string; type: string; sourceWorld: string; supportsUri: boolean; gameNames: string[] };

type Props = {
  rooms: ManagedRoom[];
  history: HistoryRun[];
  templates: Template[];
  settings: Settings;
  roomsRoot: string;
  setRooms: (rooms: ManagedRoom[]) => void;
  notify: (message: string) => void;
  connectConsole: (profile: RemoteProfile) => Promise<void>;
  associations: Record<string, PopTrackerAssociation>;
  setAssociations: (associations: Record<string, PopTrackerAssociation>) => void;
  launchProfiles: Record<string, GameLaunchProfile>;
  setLaunchProfiles: (profiles: Record<string, GameLaunchProfile>) => void;
  hostRunning: boolean;
  activeHostRoomId?: string;
  startLocal: (room: ManagedRoom) => void;
  stopLocal: () => void;
  openLocalConsole: () => void;
};

const compactDate = (value?: string) => value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Never';
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

function statusFrom(result: RoomInspection): RoomStatusSnapshot {
  return { trackerId: result.trackerId, lastPort: result.lastPort, endpoint: result.endpoint, lastActivity: result.lastActivity, timeout: result.timeout, refreshedAt: result.refreshedAt, stale: result.stale, capabilities: result.capabilities, limitedHost: result.limitedHost, snapshot: result.snapshot, passwordRequired: result.passwordRequired };
}

const endpointLabel = (room: ManagedRoom) => room.status.endpoint
  ? `${room.status.endpoint.host}:${room.status.endpoint.port}`
  : room.status.lastPort ? `archipelago.gg:${room.status.lastPort}` : 'No live endpoint';
const dashboardFingerprint = (dashboard?: RoomTrackerDashboard) => dashboard ? JSON.stringify(dashboard.players.map((player) => [player.slot, player.checksDone, player.itemsReceived, player.status])) : '';

function mergeSlots(room: ManagedRoom, result: RoomInspection): ManagedRoomSlot[] {
  return result.slots.map((slot) => {
    const existing = room.slots.find((item) => item.slot === slot.slot) ?? room.slots.find((item) => item.name === slot.name);
    const remoteFiles = (slot.remoteFiles ?? existing?.remoteFiles ?? []).map((file) => {
      const previous = existing?.remoteFiles?.find((item) => item.id === file.id || item.sourceId === file.sourceId);
      return { ...file, downloadedFileId: previous?.revision === file.revision ? previous.downloadedFileId : undefined };
    });
    return { ...slot, mine: existing?.mine ?? false, files: existing?.files ?? [], remoteFiles };
  });
}

function LaunchActionEditor({ action, setAction, slot, roomUrl, endpoint, title, minecraft }: {
  action: GameLaunchAction;
  setAction: (action: GameLaunchAction) => void;
  slot: string;
  roomUrl: string;
  endpoint: string;
  title: string;
  minecraft?: MinecraftLauncherInventory;
}) {
  const dynamicValue = action.type === 'url' || action.type === 'file' ? action.target ?? '' : action.arguments ?? '';
  const makeDynamic = () => {
    const suggested = suggestLaunchTemplate(dynamicValue, slot, roomUrl);
    setAction(action.type === 'url' || action.type === 'file' ? { ...action, target: suggested } : { ...action, arguments: suggested });
  };
  const choosePath = async () => {
    const chosen = action.type === 'program'
      ? await window.archipelago?.pickExecutable(`Choose ${title.toLowerCase()}`)
      : await window.archipelago?.pickLaunchFile(`Choose ${title.toLowerCase()}`);
    if (chosen) setAction(action.type === 'program' ? { ...action, path: chosen } : { ...action, target: chosen });
  };
  const chooseSourceMod = async () => {
    const chosen = await window.archipelago?.pickSteamSourceMod();
    if (chosen) setAction({ ...action, steamMode: 'source', appId: chosen.appId, sourceModPath: chosen.path });
  };
  const preview = previewLaunchTemplate(dynamicValue, { slot, endpoint, roomUrl });
  return <div className="launch-action-editor">
    <div className="launch-editor-title"><strong>{title}</strong><select value={action.type} onChange={(event) => { const type = event.target.value as GameLaunchAction['type']; setAction(type === 'minecraft' ? minecraftLaunchAction(minecraft) : emptyLaunchAction(type)); }}><option value="steam">Steam game</option><option value="minecraft">Minecraft installation</option><option value="program">Program</option><option value="url">Web or app link</option><option value="file">File</option></select></div>
    <div className="launch-editor-fields">
      {action.type === 'steam' && <><label>Steam target<select value={action.steamMode ?? 'app'} onChange={(event) => setAction({ ...action, steamMode: event.target.value as 'app' | 'game' | 'source', appId: '', sourceModPath: '', arguments: event.target.value === 'game' ? '' : action.arguments })}><option value="app">Store game / App ID</option><option value="source">Source mod folder</option><option value="game">Shortcut / full game ID</option></select></label><label>{action.steamMode === 'game' ? 'Full Steam game ID' : 'Steam App ID'}<input value={action.appId ?? ''} onChange={(event) => setAction({ ...action, appId: event.target.value.replace(/\D/g, '') })} placeholder={action.steamMode === 'game' ? '16657981660565865068' : action.steamMode === 'source' ? 'Read from GameInfo.txt' : '70300'} /></label>{action.steamMode === 'source' && <label className="launch-wide">Source mod folder<div className="launch-path"><input value={action.sourceModPath ?? ''} readOnly placeholder="Choose the folder containing GameInfo.txt" /><button className="secondary-button" onClick={() => void chooseSourceMod()}>Choose folder</button></div></label>}</>}
      {action.type === 'program' && <label className="launch-wide">Program<div className="launch-path"><input value={action.path ?? ''} onChange={(event) => setAction({ ...action, path: event.target.value })} placeholder="C:\\Tools\\Game\\game.exe" /><button className="secondary-button" onClick={() => void choosePath()}>Browse</button></div></label>}
      {action.type === 'minecraft' && <>{minecraft?.profiles.length ? <label className="launch-wide">Minecraft installation<select value={action.minecraftProfileId ?? ''} onChange={(event) => { const profile = minecraft.profiles.find((item) => item.id === event.target.value); if (profile) setAction({ ...minecraftLaunchAction(minecraft), minecraftProfileId: profile.id, minecraftProfileName: profile.name, minecraftVersion: profile.version }); }}>{minecraft.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.neoForge ? 'NeoForge · ' : ''}{profile.name} · {profile.version}</option>)}</select></label> : <p className="launch-note">{minecraft?.error ?? 'Minecraft Launcher and its saved installations were not found.'}</p>}<p className="launch-note">Controller verifies this exact installation and opens Minecraft Launcher. Select it there and press Play; the Archipelago mod is server-side.</p></>}
      {(action.type === 'url' || action.type === 'file') && <label className="launch-wide">{action.type === 'url' ? 'Link' : 'File'}<div className="launch-path"><input value={action.target ?? ''} onChange={(event) => setAction({ ...action, target: event.target.value })} placeholder={action.type === 'url' ? '{roomUrl}' : '{selectedFile}'} />{action.type === 'file' && <button className="secondary-button" onClick={() => void choosePath()}>Browse</button>}</div></label>}
      {((action.type === 'steam' && action.steamMode !== 'game') || action.type === 'program') && <label className="launch-wide">Launch instructions<textarea rows={2} value={action.arguments ?? ''} onChange={(event) => setAction({ ...action, arguments: event.target.value })} placeholder='Paste launch options, for example: -name MySlot -server localhost:38281' /></label>}
      {action.type === 'steam' && action.steamMode === 'game' && <p className="launch-note">Steam shortcuts use the launch options already saved in Steam.</p>}
      {action.type === 'program' && <label className="launch-wide">Working folder <span>optional</span><input value={action.workingDirectory ?? ''} onChange={(event) => setAction({ ...action, workingDirectory: event.target.value })} placeholder="Defaults to the program folder" /></label>}
    </div>
    {dynamicValue && <div className="launch-dynamic"><button className="text-button" onClick={makeDynamic}><WandSparkles size={13} />Detect room values</button><code title={preview}>{preview}</code></div>}
  </div>;
}

function LaunchProfileEditor({ game, slot, roomUrl, endpoint, existing, minecraft, onSave, onRemove, onCancel, onStart }: {
  game: string;
  slot: string;
  roomUrl: string;
  endpoint: string;
  existing?: GameLaunchProfile;
  minecraft?: MinecraftLauncherInventory;
  onSave: (profile: GameLaunchProfile) => void;
  onRemove: () => void;
  onCancel: () => void;
  onStart: (profile: GameLaunchProfile) => void;
}) {
  const [draft, setDraft] = useState<GameLaunchProfile>(() => {
    if (existing) return structuredClone(existing);
    const profile = emptyLaunchProfile(game);
    return game.trim().toLocaleLowerCase() === 'minecraft' ? { ...profile, label: 'Minecraft · NeoForge', primary: minecraftLaunchAction(minecraft) } : profile;
  });
  const prepared = () => ({ ...draft, game, label: draft.label.trim() || `${game} launch`, updatedAt: new Date().toISOString() });
  const actionComplete = (action: GameLaunchAction) => action.type === 'steam' ? /^\d{2,20}$/.test(action.appId ?? '') && (action.steamMode !== 'source' || Boolean(action.sourceModPath?.trim()))
    : action.type === 'program' ? Boolean(action.path?.trim()) : action.type === 'minecraft' ? Boolean(action.launcherPath && action.minecraftProfileId && action.minecraftVersion) : Boolean(action.target?.trim());
  const complete = actionComplete(draft.primary) && (!draft.companion || actionComplete(draft.companion));
  const importShortcut = async () => {
    const result = await window.archipelago?.pickLaunchShortcut();
    if (result) setDraft({ ...draft, primary: result.action, label: existing ? draft.label : `${game} · ${result.name}` });
  };
  return <div className={`room-launch-config ${draft.companion ? 'has-companion' : ''}`}>
    <div className="room-launch-heading"><div><Rocket size={16} /><span><strong>Teach Controller to launch {game}</strong><small>This setup is reused for {game} in every room.</small></span></div><div className="room-launch-heading-actions"><button className="secondary-button" onClick={() => void importShortcut()}><FilePlus2 size={14} />Import shortcut</button><button className="icon-button" title="Close launch setup" onClick={onCancel}>×</button></div></div>
    <label className="launch-profile-name">Profile name<input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
    <LaunchActionEditor title="Start game" action={draft.primary} setAction={(primary) => setDraft({ ...draft, primary })} slot={slot} roomUrl={roomUrl} endpoint={endpoint} minecraft={minecraft} />
    <label className="launch-companion-toggle"><input type="checkbox" checked={Boolean(draft.companion)} onChange={(event) => setDraft({ ...draft, companion: event.target.checked ? emptyLaunchAction('file') : undefined, companionMode: event.target.checked ? 'manual' : undefined, companionLabel: event.target.checked ? 'Run companion' : undefined })} /><span className="custom-check">{draft.companion && <Check size={11} />}</span><span><strong>Add a second stage</strong><small>For a randomizer or helper that starts with the game or only when you say it is ready.</small></span></label>
    {draft.companion && <div className="launch-companion-controls"><span>Start second stage</span><div className="launch-mode-control"><button className={draft.companionMode !== 'manual' ? 'active' : ''} onClick={() => setDraft({ ...draft, companionMode: 'automatic' })}>Together</button><button className={draft.companionMode === 'manual' ? 'active' : ''} onClick={() => setDraft({ ...draft, companionMode: 'manual' })}>When ready</button></div>{draft.companionMode === 'manual' && <label>Button label<input value={draft.companionLabel ?? ''} onChange={(event) => setDraft({ ...draft, companionLabel: event.target.value })} placeholder="Run randomizer" /></label>}</div>}
    {draft.companion && <LaunchActionEditor title="Second stage" action={draft.companion} setAction={(companion) => setDraft({ ...draft, companion })} slot={slot} roomUrl={roomUrl} endpoint={endpoint} minecraft={minecraft} />}
    <div className="launch-editor-actions">{existing && <button className="text-button danger" onClick={onRemove}><Trash2 size={13} />Remove setup</button>}<button className="secondary-button" disabled={!complete} onClick={() => onSave(prepared())}>Save</button><button className="primary-button" disabled={!complete} onClick={() => { const next = prepared(); onSave(next); onStart(next); }}><Play size={14} />Save & start</button></div>
  </div>;
}

export function RoomsView({ rooms, templates, settings, roomsRoot, setRooms, notify, connectConsole, associations, setAssociations, launchProfiles, setLaunchProfiles, hostRunning, activeHostRoomId, startLocal, stopLocal, openLocalConsole }: Props) {
  const [selectedId, setSelectedId] = useState(rooms[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [roomUrl, setRoomUrl] = useState('');
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [roomPasswordDraft, setRoomPasswordDraft] = useState('');
  const [inspection, setInspection] = useState<RoomInspection>();
  const [mine, setMine] = useState<number[]>([]);
  const [busy, setBusy] = useState('');
  const [chosenFiles, setChosenFiles] = useState<Record<number, string>>({});
  const [selectedDownloads, setSelectedDownloads] = useState<Record<string, boolean>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, { received: number; total?: number; fileName: string; fileId: string }>>({});
  const [managingSlots, setManagingSlots] = useState(false);
  const [popTrackerPacks, setPopTrackerPacks] = useState<PopTrackerPack[]>([]);
  const [launcherComponents, setLauncherComponents] = useState<LauncherComponent[]>([]);
  const [minecraft, setMinecraft] = useState<MinecraftLauncherInventory>();
  const [configuringTracker, setConfiguringTracker] = useState<number>();
  const [configuringLaunch, setConfiguringLaunch] = useState<number>();
  const [trackerDashboard, setTrackerDashboard] = useState<RoomTrackerDashboard>();
  const [sphereData, setSphereData] = useState<RoomSphereSnapshot>();
  const [trackerError, setTrackerError] = useState('');
  const [trackerBusy, setTrackerBusy] = useState(false);
  const [trackerTab, setTrackerTab] = useState<'progress' | 'hints' | 'activity' | 'spheres' | 'downloads'>('progress');
  const [showFoundHints, setShowFoundHints] = useState(false);
  const [logicBySlot, setLogicBySlot] = useState<Record<number, RoomLogicAnalysis>>({});
  const [logicEnvironmentByGame, setLogicEnvironmentByGame] = useState<Record<string, string>>({});
  const [playerSort, setPlayerSort] = useState<{ key: 'name' | 'checks' | 'items' | 'status' | 'activity'; direction: 1 | -1 }>({ key: 'name', direction: 1 });
  const [playerFilter, setPlayerFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [hintSlotFilter, setHintSlotFilter] = useState(0);
  const roomsRef = useRef(rooms);
  useEffect(() => { roomsRef.current = rooms; }, [rooms]);
  const selected = rooms.find((room) => room.id === selectedId) ?? rooms[0];
  const shownRooms = rooms.filter((room) => `${room.label} ${room.id} ${room.slots.map((slot) => `${slot.name} ${slot.game}`).join(' ')}`.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    const saved = { ...(selected?.logicAnalyses ?? {}), ...(selected?.status.snapshot?.enriched.logic ?? {}) } as Record<string, RoomLogicAnalysis>;
    setLogicBySlot(Object.fromEntries(Object.entries(saved).map(([slot, analysis]) => [Number(slot), analysis])));
  }, [selected?.id, selected?.status.snapshot?.original.sourceRevision]);

  useEffect(() => {
    if (!selected || !settings.installRoot || !window.archipelago?.getRoomLogicEnvironment) { setLogicEnvironmentByGame({}); return; }
    let active = true;
    const games = [...new Set(selected.slots.filter((slot) => Boolean(selected.logicAnalyses?.[slot.slot] ?? selected.status.snapshot?.enriched.logic?.[slot.slot])).map((slot) => slot.game))];
    void Promise.all(games.map(async (game) => [game.trim().toLocaleLowerCase(), await window.archipelago!.getRoomLogicEnvironment({ installRoot: settings.installRoot, game })] as const)).then((results) => {
      if (!active) return;
      setLogicEnvironmentByGame(Object.fromEntries(results.filter(([, result]) => result.fingerprint).map(([game, result]) => [game, result.fingerprint!] )));
    });
    return () => { active = false; };
  }, [selected?.id, settings.installRoot, launcherComponents.length, selected?.status.snapshot?.original.sourceRevision]);

  useEffect(() => {
    if (!window.archipelago?.takeRoomInvite || !window.archipelago.onRoomInvite) return;
    const receive = (invite: string) => { setRoomUrl(invite); setInspection(undefined); setAdding(true); };
    void window.archipelago.takeRoomInvite().then((invite) => { if (invite) receive(invite); });
    return window.archipelago.onRoomInvite(receive);
  }, []);
  useEffect(() => window.archipelago?.onRoomDownloadProgress((progress) => setDownloadProgress((current) => ({ ...current, [progress.jobId]: progress }))), []);
  useEffect(() => window.archipelago?.onRoomWakeRequest(({ roomId }) => {
    const room = roomsRef.current.find((item) => item.id === roomId);
    if (!room?.hosted?.allowRemoteWake || room.provider?.type !== 'local') return;
    if (hostRunning) { notify('Remote wake was refused because another server is active'); return; }
    startLocal(room);
  }), [hostRunning, startLocal]);

  useEffect(() => {
    if (!settings.popTrackerPath || !window.archipelago) { setPopTrackerPacks([]); return; }
    let active = true;
    void window.archipelago.inventoryPopTracker(settings.popTrackerPath).then((result) => {
      if (!active) return;
      setPopTrackerPacks(result.packs ?? []);
      if (result.error) notify(result.error);
    });
    return () => { active = false; };
  }, [settings.popTrackerPath]);

  useEffect(() => {
    if (!settings.installRoot || !window.archipelago) { setLauncherComponents([]); return; }
    let active = true;
    void window.archipelago.inventoryTools(settings.installRoot).then((result) => {
      if (active) setLauncherComponents(result.components ?? []);
    });
    return () => { active = false; };
  }, [settings.installRoot]);

  useEffect(() => {
    if (!window.archipelago) return;
    let active = true;
    void window.archipelago.inventoryMinecraftLauncher().then((result) => { if (active) setMinecraft(result); });
    return () => { active = false; };
  }, []);

  const clientFor = (game: string) => {
    const key = game.trim().toLocaleLowerCase();
    return launcherComponents.find((component) => component.type === 'client' && [component.sourceWorld, ...component.gameNames]
      .some((name) => name.trim().toLocaleLowerCase() === key));
  };

  const associationFor = (game: string): PopTrackerAssociation | undefined => {
    const key = game.trim().toLocaleLowerCase();
    const saved = associations[key];
    if (saved && popTrackerPacks.some((pack) => pack.uid === saved.packUid && pack.variants.some((variant) => variant.id === saved.variant && variant.supportsAp))) return saved;
    const aliases: Record<string, string> = {
      'the minish cap': 'minish cap randomizer',
      'the witness': 'the witness archipelago randomizer',
    };
    const expected = aliases[key] ?? key;
    const pack = popTrackerPacks.find((item) => item.gameName.trim().toLocaleLowerCase() === expected);
    const variant = pack?.variants.find((item) => item.supportsAp);
    return pack && variant ? { packUid: pack.uid, variant: variant.id } : undefined;
  };

  const setAssociation = (game: string, next?: PopTrackerAssociation) => {
    const key = game.trim().toLocaleLowerCase();
    const updated = { ...associations };
    if (next) updated[key] = next;
    else delete updated[key];
    setAssociations(updated);
  };

  const replaceRoom = (next: ManagedRoom) => {
    const updated = roomsRef.current.map((room) => room.id === next.id ? next : room);
    roomsRef.current = updated;
    setRooms(updated);
  };

  const loadTrackerDashboard = async (room: ManagedRoom, quiet = false) => {
    if (room.provider?.type !== 'official' && window.archipelago?.getRoomSpheres) {
      const spheres = await window.archipelago.getRoomSpheres({ roomId: room.id, roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider });
      if (!('error' in spheres && spheres.ok === false)) setSphereData(spheres);
    }
    const localTracker = room.provider?.type === 'local' && hostRunning && activeHostRoomId === room.id;
    const controllerTracker = room.provider?.type === 'controller' && room.status.capabilities?.progress;
    if ((!room.status.trackerId && !localTracker && !controllerTracker) || !window.archipelago?.getRoomTrackerDashboard) {
      setTrackerDashboard(undefined);
      setTrackerError(room.provider?.type === 'official' ? 'This room has no tracker data yet.' : room.provider?.type === 'local' ? 'Start this room server to enable exact live progress and hints.' : 'Live progress is not available from this room provider.');
      return;
    }
    if (!quiet) setTrackerBusy(true);
    const result = await window.archipelago.getRoomTrackerDashboard({ roomId: room.id, roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, trackerId: room.status.trackerId ?? '', slots: room.slots });
    if ('error' in result && result.ok === false) {
      setTrackerError(result.error);
    } else {
      setTrackerDashboard(result);
      setTrackerError('');
    }
    if (!quiet) setTrackerBusy(false);
  };

  useEffect(() => {
    setTrackerDashboard(undefined);
    setSphereData(undefined);
    setTrackerError('');
    if (!selected) return;
    void loadTrackerDashboard(selected);
    const localLive = selected.provider?.type === 'local' && hostRunning && activeHostRoomId === selected.id;
    const timer = window.setInterval(() => void loadTrackerDashboard(selected, true), localLive || selected.status.endpoint ? 5_000 : 15_000);
    return () => window.clearInterval(timer);
    // A saved room replacement should not restart the tracker timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status.trackerId, hostRunning, activeHostRoomId]);

  useEffect(() => {
    if (!window.archipelago?.onRoomShareStatus) return;
    return window.archipelago.onRoomShareStatus((status) => {
      if (!status.roomId) return;
      setRooms(rooms.map((room) => room.id === status.roomId && room.hosted ? {
        ...room, hosted: { ...room.hosted, shareStatus: { ...room.hosted.shareStatus, ...status } as RoomShareStatus },
      } : room));
    });
  }, [rooms, setRooms]);

  const syncFiles = async (room: ManagedRoom) => {
    if (!window.archipelago) return room;
    const inventories = await Promise.all(room.slots.filter((slot) => slot.mine).map(async (slot) => ({
      slot: slot.slot,
      result: await window.archipelago!.listRoomFiles({ roomsRoot, folderPath: room.folderPath, slot: slot.slot, slotName: slot.name }),
    })));
    const bySlot = new Map(inventories.map((item) => [item.slot, item.result]));
    const next = { ...room, slots: room.slots.map((slot) => {
      const result = bySlot.get(slot.slot);
      return result && !result.error ? { ...slot, files: [...(result.downloads ?? []), ...(result.play ?? [])] } : slot;
    }) };
    replaceRoom(next);
    return next;
  };

  const refresh = async (room: ManagedRoom, wake = false, quiet = false) => {
    if (!window.archipelago) return room;
    if (room.provider?.type === 'local') {
      const running = hostRunning && activeHostRoomId === room.id;
      const next = { ...room, status: { ...room.status, lastPort: room.hosted?.gamePort, endpoint: running ? { host: 'localhost', port: room.hosted?.gamePort ?? 38281, secure: false } : undefined, refreshedAt: new Date().toISOString(), stale: false } };
      replaceRoom(next);
      await syncFiles(next);
      return next;
    }
    if (!quiet) setBusy(`refresh:${room.id}`);
    const result = await window.archipelago.inspectRoom({ url: room.provider?.roomUrl ?? room.url, wake });
    if ('error' in result && result.ok === false) {
      const stale = { ...room, status: { ...room.status, stale: true, error: result.error } };
      replaceRoom(stale);
      if (!quiet) notify(result.error);
      if (!quiet) setBusy('');
      return stale;
    }
    const next = { ...room, provider: result.provider ?? room.provider, passwordRequired: result.passwordRequired ?? room.passwordRequired, slots: mergeSlots(room, result), status: statusFrom(result) };
    replaceRoom(next);
    if (!quiet) notify(result.lastPort ? `Room available on port ${result.lastPort}` : 'Room refreshed, but no server port is active');
    if (!quiet) setBusy('');
    return next;
  };

  const wakeControllerRoom = async (room: ManagedRoom) => {
    if (!room.provider || room.provider.type !== 'controller') return;
    setBusy(`wake:${room.id}`);
    const result = await window.archipelago?.wakeRoom({ roomUrl: room.provider.roomUrl ?? room.url, provider: room.provider });
    setBusy('');
    notify(result?.error ?? `Remote wake: ${result?.status ?? 'requested'}`);
    if (result?.status === 'online' || result?.status === 'starting') window.setTimeout(() => void refresh(room, false, true), 1500);
  };

  const saveRoomPassword = async (room: ManagedRoom, remove = false) => {
    const passwordRef = room.passwordRef || `room:${room.id}:password`;
    if (remove) await window.archipelago?.removeSecret(passwordRef);
    else if (roomPasswordDraft) await window.archipelago?.setSecret({ id: passwordRef, value: roomPasswordDraft });
    else return;
    replaceRoom({ ...room, passwordRef, passwordSet: !remove, autoLoginWarningAccepted: false });
    setRoomPasswordDraft('');
    notify(remove ? 'Room password removed' : 'Room password encrypted and saved');
  };

  useEffect(() => {
    if (!selected) return;
    void (async () => {
      const fresh = Date.now() - new Date(selected.status.refreshedAt).getTime() >= 60_000 ? await refresh(selected, false, true) : selected;
      await syncFiles(fresh);
    })();
    // Refresh only as the selected room changes; replaceRoom would otherwise make a request loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    if (!selected || selected.provider?.type === 'local') return;
    let cancelled = false;
    let timer = 0;
    let failures = 0;
    const poll = async () => {
      const room = roomsRef.current.find((item) => item.id === selected.id);
      if (!room || cancelled) return;
      const next = await refresh(room, false, true);
      failures = next.status.stale ? Math.min(failures + 1, 3) : 0;
      const base = next.status.endpoint ? 5_000 : 15_000;
      timer = window.setTimeout(() => void poll(), Math.min(60_000, base * (2 ** failures)));
    };
    timer = window.setTimeout(() => void poll(), selected.status.endpoint ? 5_000 : 15_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // Poll by selected identity; roomsRef supplies the latest persisted room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const inspect = async () => {
    if (!roomUrl.trim() || !window.archipelago) return;
    setBusy('inspect');
    const result = await window.archipelago.inspectRoom({ url: roomUrl, wake: true });
    setBusy('');
    if ('error' in result && result.ok === false) { notify(result.error); return; }
    if (rooms.some((room) => room.id === result.roomId)) { setSelectedId(result.roomId); setAdding(false); notify('That room is already saved'); return; }
    setInspection(result);
    setLabel(`Room ${result.roomId.slice(0, 8)}`);
    setMine([]);
  };

  const saveRoom = async () => {
    if (!inspection || !mine.length || !window.archipelago) { notify('Select at least one of your slots'); return; }
    setBusy('save');
    const ensured = await window.archipelago.ensureRoom({ roomsRoot, label, roomId: inspection.roomId });
    if (!ensured.folderPath) { setBusy(''); notify(ensured.error ?? 'Room folder could not be created'); return; }
    const passwordRef = `room:${inspection.roomId}:password`;
    if (password) await window.archipelago.setSecret({ id: passwordRef, value: password });
    const room: ManagedRoom = {
      id: inspection.roomId, label: label.trim() || `Room ${inspection.roomId.slice(0, 8)}`, url: inspection.url,
      folderPath: ensured.folderPath, createdAt: new Date().toISOString(), passwordRef, passwordSet: Boolean(password),
      passwordRequired: inspection.passwordRequired,
      autoLoginWarningAccepted: false, status: statusFrom(inspection),
      provider: inspection.provider ?? { type: 'official', roomUrl: inspection.url },
      slots: inspection.slots.map((slot) => ({ ...slot, mine: mine.includes(slot.slot), files: [] })),
    };
    setRooms([room, ...rooms]);
    setSelectedId(room.id);
    setAdding(false); setInspection(undefined); setRoomUrl(''); setPassword(''); setBusy('');
    notify('Room saved');
  };

  const updateSlot = (room: ManagedRoom, slotNumber: number, patch: Partial<ManagedRoomSlot>) => replaceRoom({ ...room, slots: room.slots.map((slot) => slot.slot === slotNumber ? { ...slot, ...patch } : slot) });

  const download = async (room: ManagedRoom, slot: ManagedRoomSlot, fileIds?: string[]) => {
    const jobId = `room-${room.id}-${slot.slot}-${Date.now()}`;
    setBusy(`download:${slot.slot}`);
    const result = await window.archipelago?.downloadRoomSlot({ roomsRoot, folderPath: room.folderPath, roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, slot: slot.slot, slotName: slot.name, fileIds, jobId });
    setBusy('');
    setDownloadProgress((current) => { const next = { ...current }; delete next[jobId]; return next; });
    if (!result || !Array.isArray(result)) { notify(result?.error ?? 'Download failed'); return; }
    const currentRoom = roomsRef.current.find((item) => item.id === room.id) ?? room;
    const currentSlot = currentRoom.slots.find((item) => item.slot === slot.slot) ?? slot;
    const downloadedSourceIds = new Set(result.map((file) => file.sourceFileId).filter(Boolean));
    const files = [...currentSlot.files.filter((file) => !file.sourceFileId || !downloadedSourceIds.has(file.sourceFileId)), ...result];
    const remoteFiles = (currentSlot.remoteFiles ?? []).map((file) => downloadedSourceIds.has(file.id)
      ? { ...file, downloadedFileId: result.find((item) => item.sourceFileId === file.id)?.id }
      : file);
    updateSlot(currentRoom, slot.slot, { files, remoteFiles });
    notify(`Downloaded ${result.length} file${result.length === 1 ? '' : 's'} for ${slot.name}`);
  };

  const downloadSelection = async (room: ManagedRoom, all = false) => {
    const groups = room.slots.map((slot) => ({
      slot,
      fileIds: (slot.remoteFiles ?? []).filter((file) => all || selectedDownloads[`${slot.slot}:${file.id}`]).map((file) => file.id),
    })).filter((group) => group.fileIds.length);
    if (!groups.length) { notify('Select at least one shared file'); return; }
    for (const group of groups) await download(room, group.slot, group.fileIds);
    setSelectedDownloads({});
  };

  const importFile = async (room: ManagedRoom, slot: ManagedRoomSlot) => {
    const result = await window.archipelago?.importRoomFile({ roomsRoot, folderPath: room.folderPath, slot: slot.slot, slotName: slot.name });
    if (!result || result.canceled) return;
    if (!result.files) { notify(result.error ?? 'File could not be imported'); return; }
    updateSlot(room, slot.slot, { files: [...slot.files.filter((file) => !['downloaded', 'imported'].includes(file.kind)), ...result.files] });
    notify('File added to the room');
  };

  const launchFile = async (room: ManagedRoom, slot: ManagedRoomSlot) => {
    const sources = slot.files.filter((file) => ['downloaded', 'imported'].includes(file.kind));
    const source = sources.find((file) => file.id === chosenFiles[slot.slot]) ?? sources[0];
    if (!source) { notify('Download or add a patch file first'); return; }
    let accepted = room.autoLoginWarningAccepted;
    if (room.passwordSet && !accepted) {
      accepted = window.confirm('Full auto-login passes this room password to the Archipelago Launcher as a process argument. Other software on this PC may briefly be able to see it. Continue?');
      if (!accepted) return;
      room = { ...room, autoLoginWarningAccepted: true };
      replaceRoom(room);
    }
    setBusy(`play:${slot.slot}`);
    const result = await window.archipelago?.launchRoomFile({ installRoot: settings.installRoot, roomsRoot, folderPath: room.folderPath, roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, roomId: room.id,
      slot: slot.slot, slotName: slot.name, game: slot.game, sourcePath: source.path, sourceFileId: source.id,
      passwordRef: room.passwordRef, autoConnect: true });
    setBusy('');
    if (!result?.file) { notify(result?.error ?? 'Patch could not be opened'); return; }
    const prepared = result.file;
    updateSlot(room, slot.slot, { files: [...slot.files.filter((file) => file.id !== prepared.id), prepared] });
    const warning = result.warnings?.[0];
    notify(warning ?? (result.capability?.supportsUri ? 'Patch opened and live connection sent to its client' : 'Patch opened; this client does not advertise automatic URI login'));
  };

  const launchClient = async (room: ManagedRoom, slot: ManagedRoomSlot) => {
    if (room.passwordSet && !room.autoLoginWarningAccepted) {
      const accepted = window.confirm('Full auto-login passes this room password to the Archipelago Launcher as a process argument. Other software on this PC may briefly be able to see it. Continue?');
      if (!accepted) return;
      room = { ...room, autoLoginWarningAccepted: true };
      replaceRoom(room);
    }
    const result = await window.archipelago?.launchRoomClient({ installRoot: settings.installRoot, roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, roomId: room.id, slotName: slot.name, game: slot.game, passwordRef: room.passwordRef });
    notify(result?.error ?? (result?.capability?.supportsUri ? `${result.capability.displayName ?? slot.game} opened` : 'Connection sent to the Archipelago Launcher'));
  };

  const connect = async (room: ManagedRoom, slot: ManagedRoomSlot) => {
    if (room.provider?.type === 'local') {
      if (!hostRunning || activeHostRoomId !== room.id) { notify('Start this room server before opening its console'); return; }
      openLocalConsole();
      return;
    }
    await connectConsole({
    id: `room:${room.id}:${slot.slot}`, label: room.label, address: room.status.endpoint ? `${room.status.endpoint.host}:${room.status.endpoint.port}` : room.status.lastPort ? `archipelago.gg:${room.status.lastPort}` : '',
    slotName: slot.name, roomPasswordRef: room.passwordRef, roomPasswordSet: room.passwordSet,
    serverPasswordSet: false, roomId: room.id, roomSlot: slot.slot, roomUrl: room.provider?.roomUrl ?? room.url, roomProvider: room.provider,
    });
  };

  const tracker = async (room: ManagedRoom, slot?: ManagedRoomSlot) => {
    const result = await window.archipelago?.openRoomTracker({ roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, trackerId: room.status.trackerId ?? '', slot: slot?.slot });
    if (result?.error) notify(result.error);
  };

  const sphereTracker = async (room: ManagedRoom) => {
    const result = await window.archipelago?.openRoomSphereTracker({ roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, trackerId: room.status.trackerId ?? '' });
    if (result?.error) notify(result.error);
  };

  const launchUniversalTracker = async (room: ManagedRoom, slot: ManagedRoomSlot) => {
    if (room.passwordSet && !room.autoLoginWarningAccepted) {
      const accepted = window.confirm('Universal Tracker auto-login passes this room password to the Archipelago Launcher as a process argument. Other software on this PC may briefly be able to see it. Continue?');
      if (!accepted) return;
      room = { ...room, autoLoginWarningAccepted: true };
      replaceRoom(room);
    }
    setBusy(`universal:${slot.slot}`);
    const template = templates.find((item) => item.game.trim().toLocaleLowerCase() === slot.game.trim().toLocaleLowerCase());
    const result = await window.archipelago?.launchRoomUniversalTracker({ installRoot: settings.installRoot, roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, roomId: room.id, slotName: slot.name, game: slot.game, passwordRef: room.passwordRef, yamlContent: template?.content });
    setBusy('');
    notify(result?.error ?? `Universal Tracker opened for ${slot.name}`);
  };

  const analyzeUniversalTracker = async (room: ManagedRoom, slot: ManagedRoomSlot) => {
    const template = templates.find((item) => item.game.trim().toLocaleLowerCase() === slot.game.trim().toLocaleLowerCase());
    if (!template) { notify(`Add a ${slot.game} YAML to the Template Library before analyzing its logic`); return; }
    if (room.passwordSet && !room.autoLoginWarningAccepted) {
      const accepted = window.confirm('Universal Tracker analysis passes this room password to the Archipelago process as an argument. Other software on this PC may briefly be able to see it. Continue?');
      if (!accepted) return;
      room = { ...room, autoLoginWarningAccepted: true };
      replaceRoom(room);
    }
    setBusy(`analyze:${slot.slot}`);
    const result = await window.archipelago?.analyzeRoomUniversalTracker({ installRoot: settings.installRoot, roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, roomId: room.id, slot: slot.slot, slotName: slot.name, game: slot.game, passwordRef: room.passwordRef, yamlContent: template.content, stateFingerprint: dashboardFingerprint(trackerDashboard) });
    setBusy('');
    if (!result || 'error' in result && result.ok === false) { notify(result?.error ?? 'Universal Tracker analysis failed'); return; }
    setLogicBySlot((current) => ({ ...current, [slot.slot]: result }));
    const currentRoom = roomsRef.current.find((item) => item.id === room.id) ?? room;
    replaceRoom({ ...currentRoom, logicAnalyses: { ...(currentRoom.logicAnalyses ?? {}), [slot.slot]: result } });
    if (result.environmentFingerprint) setLogicEnvironmentByGame((current) => ({ ...current, [slot.game.trim().toLocaleLowerCase()]: result.environmentFingerprint! }));
    notify(`${slot.name}: ${result.inLogic} in logic, ${result.glitched} glitched`);
  };

  const cancelUniversalTracker = async (room: ManagedRoom, slot: ManagedRoomSlot) => {
    const result = await window.archipelago?.cancelRoomUniversalTracker({ roomId: room.id, slotName: slot.name });
    if (result?.cancelled) notify(`Cancelled logic analysis for ${slot.name}`);
  };

  const installRoomTool = async (worldId: 'tracker' | 'slotlock') => {
    if (!window.confirm(`${worldId === 'tracker' ? 'Universal Tracker' : 'SlotLock'} is an APWorld package and contains executable Python code. Install the newest compatible indexed release?`)) return;
    setBusy(`install:${worldId}`);
    const result = await window.archipelago?.installRequiredRoomApWorld({ installRoot: settings.installRoot, worldId });
    setBusy('');
    if (!result?.installed) {
      if (result?.sourceUrl) await window.archipelago?.openExternal(result.sourceUrl);
      notify(result?.error ?? 'No compatible indexed release is available.');
      return;
    }
    const tools = await window.archipelago?.inventoryTools(settings.installRoot);
    setLauncherComponents(tools?.components ?? []);
    notify(worldId === 'tracker' ? 'Universal Tracker installed' : 'SlotLock installed');
  };

  const copyConnection = async (room: ManagedRoom, slot?: ManagedRoomSlot) => {
    const endpoint = endpointLabel(room);
    await navigator.clipboard.writeText(slot ? `${endpoint}\nSlot: ${slot.name}\nGame: ${slot.game}` : `${room.url}\n${endpoint}`);
    notify('Connection details copied without the password');
  };

  const launchPopTracker = async (room: ManagedRoom, slot: ManagedRoomSlot) => {
    const association = associationFor(slot.game);
    if (!association || !settings.popTrackerPath) { setConfiguringTracker(slot.slot); notify('Choose a PopTracker pack for this game'); return; }
    if (room.passwordSet && !room.autoLoginWarningAccepted) {
      const accepted = window.confirm('Full PopTracker auto-login passes this room password as a process argument. Other software on this PC may briefly be able to see it. Continue?');
      if (!accepted) return;
      room = { ...room, autoLoginWarningAccepted: true };
      replaceRoom(room);
    }
    setBusy(`tracker:${slot.slot}`);
    const result = await window.archipelago?.launchRoomPopTracker({ executablePath: settings.popTrackerPath, roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, roomId: room.id,
      slotName: slot.name, passwordRef: room.passwordRef, packUid: association.packUid, variant: association.variant });
    setBusy('');
    notify(result?.error ?? `${result?.pack?.name ?? 'PopTracker'} opened and connected as ${slot.name}`);
  };

  const saveLaunchProfile = (profile: GameLaunchProfile) => {
    setLaunchProfiles({ ...launchProfiles, [launchProfileKey(profile.game)]: profile });
    setConfiguringLaunch(undefined);
    notify(`${profile.game} launch setup saved`);
  };

  const removeLaunchProfile = (game: string) => {
    const updated = { ...launchProfiles };
    delete updated[launchProfileKey(game)];
    setLaunchProfiles(updated);
    setConfiguringLaunch(undefined);
    notify(`${game} launch setup removed`);
  };

  const startGame = async (room: ManagedRoom, slot: ManagedRoomSlot, profile?: GameLaunchProfile, stage: 'primary' | 'companion' = 'primary') => {
    const selectedProfile = profile ?? launchProfiles[launchProfileKey(slot.game)];
    if (!selectedProfile) { setConfiguringLaunch(slot.slot); return; }
    const sources = slot.files.filter((file) => ['downloaded', 'imported', 'prepared', 'generated'].includes(file.kind));
    const source = sources.find((file) => file.id === chosenFiles[slot.slot]) ?? sources[0];
    const busyKey = stage === 'companion' ? `companion:${slot.slot}` : `launch:${slot.slot}`;
    setBusy(busyKey);
    const launchStage = stage === 'companion' ? 'companion' : selectedProfile.companionMode === 'manual' ? 'primary' : 'all';
    const result = await window.archipelago?.launchRoomProfile({ roomUrl: room.provider?.roomUrl ?? room.url, provider: room.provider, roomId: room.id, roomsRoot, roomFolder: room.folderPath, slotName: slot.name, game: slot.game, selectedFile: source?.path, profile: selectedProfile, stage: launchStage });
    setBusy('');
    if (result?.status) replaceRoom({ ...room, status: result.status });
    const nextStep = result?.deferred ? ` · use ${selectedProfile.companionLabel || 'Run companion'} when ready` : '';
    notify(result?.error ?? `${selectedProfile.label} started${result?.launched?.length ? `: ${result.launched.join(' + ')}` : ''}${nextStep}`);
  };

  const updateHosted = (room: ManagedRoom, patch: Partial<NonNullable<ManagedRoom['hosted']>>) => {
    if (!room.hosted) return;
    replaceRoom({ ...room, hosted: { ...room.hosted, ...patch } });
  };

  const startSharing = async (room: ManagedRoom) => {
    if (!room.hosted) return;
    setBusy('share');
    const result = await window.archipelago?.startRoomSharing({
      installRoot: settings.installRoot, roomsRoot, roomId: room.id, label: room.label, folderPath: room.folderPath, slots: room.slots,
      sharedSlots: room.hosted.sharedSlots, hosted: room.hosted, createdAt: room.createdAt, passwordRequired: room.passwordSet,
      gateway: { mode: settings.roomGatewayMode, hostname: settings.roomGatewayHostname, email: settings.roomGatewayEmail, publicBaseUrl: settings.roomGatewayPublicUrl },
      hostApi: { secretRef: settings.roomHostApiKeyRef, remoteEnabled: settings.roomHostApiRemote, allowSpoilers: settings.allowSpoilerApi },
    });
    setBusy('');
    if (!result || result.error && !result.portalRunning) { notify(result?.error ?? 'Room portal could not start'); return; }
    updateHosted(room, {
      advertisedHost: result.advertisedHost ?? room.hosted.advertisedHost,
      shareStatus: { ...room.hosted.shareStatus, ...result } as RoomShareStatus,
    });
    notify(result.error ? `Room shared; automatic mapping failed: ${result.error}` : `Room shared${result.mappingMethod ? ` through ${result.mappingMethod}` : ''}`);
  };

  const stopSharing = async (room: ManagedRoom) => {
    const result = await window.archipelago?.stopRoomSharing({ roomId: room.id });
    if (result?.error) { notify(result.error); return; }
    if (room.hosted) updateHosted(room, { shareStatus: { ...room.hosted.shareStatus, ...result } as RoomShareStatus });
    notify('Room sharing stopped');
  };

  const copyInvite = async (room: ManagedRoom, kind: 'browser' | 'controller') => {
    const result = await window.archipelago?.copyRoomInvite({ roomId: room.id, kind });
    notify(result?.error ?? `${kind === 'browser' ? 'Browser' : 'Controller'} invitation copied`);
  };

  const copySecureEndpoint = async (room: ManagedRoom) => {
    const endpoint = room.hosted?.shareStatus.secureGameEndpoint;
    if (!endpoint) return;
    await navigator.clipboard.writeText(endpoint);
    notify('Secure game endpoint copied');
  };

  const forget = async (room: ManagedRoom) => {
    if (!window.confirm(`Forget ${room.label}? Its downloaded files will remain on disk.`)) return;
    if (room.hosted?.shareStatus.portalRunning) await window.archipelago?.stopRoomSharing({ roomId: room.id });
    if (room.passwordRef) await window.archipelago?.removeSecret(room.passwordRef);
    setRooms(rooms.filter((item) => item.id !== room.id));
    setSelectedId(rooms.find((item) => item.id !== room.id)?.id ?? '');
  };

  const mineSlots = useMemo(() => selected?.slots.filter((slot) => slot.mine) ?? [], [selected]);
  const visibleHints = trackerDashboard?.hints.filter((hint) => (showFoundHints || !hint.found) && (!hintSlotFilter || hint.receivingSlot === hintSlotFilter || hint.findingSlot === hintSlotFilter)) ?? [];
  const roomActivity = selected?.status.snapshot?.enriched.activity ?? [];
  const roomSpheres: RoomSphereSnapshot | undefined = sphereData ?? selected?.status.snapshot?.enriched.spheres;
  const universalTrackerInstalled = launcherComponents.some((component) => component.displayName === 'Universal Tracker');
  const slotLockRequired = Boolean(selected?.slots.some((slot) => /slotlock/i.test(slot.game)));
  const slotLockInstalled = launcherComponents.some((component) => /slotlock/i.test(`${component.displayName} ${component.sourceWorld}`));
  const currentTrackerFingerprint = dashboardFingerprint(trackerDashboard);
  const remoteDownloads = selected?.slots.flatMap((slot) => (slot.remoteFiles ?? []).map((file) => ({ slot, file }))) ?? [];
  const selectedDownloadCount = remoteDownloads.filter(({ slot, file }) => selectedDownloads[`${slot.slot}:${file.id}`]).length;
  const sortedTrackerPlayers = [...(trackerDashboard?.players ?? [])].filter((player) => {
    const filter = playerFilter.trim().toLocaleLowerCase();
    return (!filter || `${player.name} ${player.alias ?? ''} ${player.game}`.toLocaleLowerCase().includes(filter)) && (statusFilter === 'all' || player.statusLabel.toLocaleLowerCase().includes(statusFilter));
  }).sort((left, right) => {
    const value = (player: RoomTrackerDashboard['players'][number]) => playerSort.key === 'name' ? player.alias || player.name
      : playerSort.key === 'checks' ? player.checksDone : playerSort.key === 'items' ? player.itemsReceived
        : playerSort.key === 'status' ? player.status : player.lastActivity || '';
    const a = value(left); const b = value(right);
    return playerSort.direction * (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
  });
  const sortPlayers = (key: typeof playerSort.key) => setPlayerSort((current) => current.key === key ? { key, direction: current.direction === 1 ? -1 : 1 } : { key, direction: 1 });
  const progressFor = (fileId: string) => Object.entries(downloadProgress).find(([, progress]) => progress.fileId === fileId);
  const gatewayReady = settings.roomGatewayMode === 'managed'
    ? Boolean(settings.roomGatewayHostname.trim() && settings.roomGatewayEmail.trim())
    : settings.roomGatewayMode === 'external'
      ? settings.roomGatewayPublicUrl.trim().startsWith('https://')
      : settings.roomGatewayMode === 'direct';
  const gatewayLabel = settings.roomGatewayMode === 'managed'
    ? settings.roomGatewayHostname || 'Managed HTTPS not configured'
    : settings.roomGatewayMode === 'external'
      ? settings.roomGatewayPublicUrl || 'External HTTPS not configured'
      : settings.roomGatewayMode === 'direct' ? 'Direct HTTP' : 'Local only';

  return <div className="rooms-view">
    <aside className="rooms-sidebar">
      <div className="rooms-sidebar-heading"><div><Link size={18} /><strong>Saved rooms</strong></div><button className="icon-button" title="Add room" onClick={() => { setAdding(true); setInspection(undefined); }}><Plus size={16} /></button></div>
      <label className="room-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rooms or slots" /></label>
      <div className="room-list">{shownRooms.map((room) => { const localOnline = room.provider?.type === 'local' && hostRunning && activeHostRoomId === room.id; return <button key={room.id} className={room.id === selected?.id ? 'active' : ''} onClick={() => setSelectedId(room.id)}><span className={`room-state ${room.status.stale ? 'stale' : localOnline || room.status.lastPort && room.provider?.type !== 'local' ? 'online' : ''}`} /><span><strong>{room.label}</strong><small>{room.provider?.type === 'local' ? localOnline ? `Localhost:${room.hosted?.gamePort}` : 'Local room offline' : endpointLabel(room)} · {room.slots.filter((slot) => slot.mine).length} slots</small></span></button>; })}</div>
    </aside>
    <section className="room-workspace">
      {adding ? <div className="room-add">
        <div className="page-heading"><div><h1>Add Room</h1><p>Save a stable Archipelago room link and choose your slots.</p></div></div>
        <div className="room-add-fields"><label>Room link<input value={roomUrl} onChange={(event) => setRoomUrl(event.target.value)} placeholder="https://archipelago.gg/room/..." autoFocus /></label><button className="primary-button" disabled={!roomUrl.trim() || busy === 'inspect'} onClick={() => void inspect()}>{busy === 'inspect' ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />}Inspect room</button></div>
        {inspection && <div className="room-add-result"><div className="room-add-fields"><label>Room label<input value={label} onChange={(event) => setLabel(event.target.value)} /></label><label>Room password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Optional" /></label></div><div className="room-slot-picker"><strong>Select your slots</strong>{inspection.slots.map((slot) => <label key={slot.slot}><input type="checkbox" checked={mine.includes(slot.slot)} onChange={() => setMine((current) => current.includes(slot.slot) ? current.filter((value) => value !== slot.slot) : [...current, slot.slot])} /><span className="custom-check">{mine.includes(slot.slot) && <Check size={11} />}</span><span><strong>{slot.name}</strong><small>{slot.game}{slot.downloadAvailable ? ' · Download available' : ''}</small></span></label>)}</div><div className="room-add-actions"><button className="secondary-button" onClick={() => setAdding(false)}>Cancel</button><button className="primary-button" disabled={!mine.length || busy === 'save'} onClick={() => void saveRoom()}><Plus size={15} />Save room</button></div></div>}
      </div> : selected ? <>
        <header className="room-heading"><div><h1>{selected.label}</h1><p>{selected.provider?.type === 'local' ? 'Controller-hosted room' : selected.url} · Refreshed {compactDate(selected.status.refreshedAt)}</p></div><div className="room-heading-actions"><span className="status-chip neutral">{selected.provider?.type ?? 'official'}</span><span className={`status-chip ${selected.status.stale ? 'warn' : selected.provider?.type === 'local' ? hostRunning && activeHostRoomId === selected.id ? 'good' : 'neutral' : selected.status.lastPort ? 'good' : 'neutral'}`}>{selected.status.stale ? 'Stale' : selected.provider?.type === 'local' ? hostRunning && activeHostRoomId === selected.id ? `Port ${selected.hosted?.gamePort}` : 'Offline' : selected.status.lastPort ? `Port ${selected.status.lastPort}` : 'No active port'}</span><button className="icon-button" title="Refresh room" onClick={() => void refresh(selected, true).then(syncFiles)}>{busy === `refresh:${selected.id}` ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />}</button><button className="icon-button" title="Copy room connection" onClick={() => void copyConnection(selected)}><Clipboard size={15} /></button><button className="icon-button" title="Open room folder" onClick={() => void window.archipelago?.reveal(selected.folderPath)}><FolderOpen size={15} /></button>{selected.provider?.type === 'official' && <button className="icon-button" title="Open room page" onClick={() => void window.archipelago?.openExternal(selected.url)}><ExternalLink size={15} /></button>}{selected.provider?.type === 'local' && selected.hosted?.shareStatus.portalRunning && <button className="icon-button" title="Open shared room page" onClick={() => void window.archipelago?.openRoomShare({ roomId: selected.id })}><ExternalLink size={15} /></button>}<button className="icon-button danger" title="Forget room" onClick={() => void forget(selected)}><Trash2 size={15} /></button></div></header>
        {selected.status.error && <div className="room-error">{selected.status.error} Last successful room data is still shown.</div>}
        {selected.status.limitedHost && <div className="room-error">Limited 0.1 host — endpoint, downloads, and launching work, but rich progress, spheres, logic, and remote wake require Controller 0.2.0 on the host.</div>}
        <div className="room-password-control"><span><strong>Room password{selected.passwordRequired ? ' required' : ''}</strong><small>{selected.passwordSet ? 'Saved securely on this computer' : selected.passwordRequired ? 'This room requires a password before clients can connect' : 'Not configured'}</small></span><input type="password" value={roomPasswordDraft} onChange={(event) => setRoomPasswordDraft(event.target.value)} placeholder={selected.passwordSet ? 'Enter a replacement' : 'Enter password if required'} /><button className="secondary-button" disabled={!roomPasswordDraft} onClick={() => void saveRoomPassword(selected)}>Save</button>{selected.passwordSet && <button className="text-button danger" onClick={() => void saveRoomPassword(selected, true)}>Remove</button>}</div>
        {selected.provider?.type === 'local' && selected.hosted && <section className="internet-hosting"><div className="internet-hosting-heading"><div><Globe2 size={18} /><span><strong>Internet Hosting</strong><small>Run the game server and share selected slot downloads.</small></span></div><div className="internet-hosting-actions">{hostRunning && activeHostRoomId === selected.id ? <button className="secondary-button" onClick={stopLocal}><Power size={14} />Stop server</button> : <button className="primary-button" disabled={hostRunning && activeHostRoomId !== selected.id} onClick={() => startLocal(selected)}><Play size={14} />Start server</button>}{selected.hosted.shareStatus.portalRunning ? <button className="secondary-button" onClick={() => void stopSharing(selected)}><Power size={14} />Stop sharing</button> : settings.roomGatewayMode !== 'local' && <button className="primary-button" disabled={busy === 'share' || !gatewayReady} onClick={() => void startSharing(selected)}>{busy === 'share' ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}Share room</button>}</div></div><div className="internet-hosting-grid"><label>Public game hostname<input value={settings.roomGatewayMode === 'managed' ? settings.roomGatewayHostname : selected.hosted.advertisedHost} disabled={settings.roomGatewayMode === 'managed' || selected.hosted.shareStatus.portalRunning} onChange={(event) => updateHosted(selected, { advertisedHost: event.target.value.trim() })} placeholder="Automatic when UPnP succeeds" /></label><label>Raw game port<input type="number" min={1} max={65535} value={selected.hosted.gamePort} disabled={hostRunning || selected.hosted.shareStatus.portalRunning} onChange={(event) => updateHosted(selected, { gamePort: Number(event.target.value) })} /></label><label>Portal port<input type="number" min={1} max={65535} value={selected.hosted.portalPort} disabled={selected.hosted.shareStatus.portalRunning} onChange={(event) => updateHosted(selected, { portalPort: Number(event.target.value) })} /></label><label>Room gateway<input value={gatewayLabel} readOnly /></label></div><div className="internet-hosting-options"><label><input type="checkbox" checked={selected.hosted.automaticPortMapping} disabled={selected.hosted.shareStatus.portalRunning} onChange={(event) => updateHosted(selected, { automaticPortMapping: event.target.checked })} /><span className="custom-check">{selected.hosted.automaticPortMapping && <Check size={11} />}</span>Automatic UPnP / NAT-PMP mapping</label>{settings.roomGatewayMode === 'direct' && <label className="http-warning"><input type="checkbox" checked={selected.hosted.insecureHttpAccepted} disabled={selected.hosted.shareStatus.portalRunning} onChange={(event) => updateHosted(selected, { insecureHttpAccepted: event.target.checked })} /><span className="custom-check">{selected.hosted.insecureHttpAccepted && <Check size={11} />}</span>I understand direct HTTP invitations are not encrypted</label>}{settings.roomGatewayMode === 'local' && <span className="local-sharing-note">Choose a public gateway in Settings to create internet invitations.</span>}</div><div className="share-status-row"><span>Server <b>{hostRunning && activeHostRoomId === selected.id ? 'Online' : 'Offline'}</b></span><span>Portal <b>{selected.hosted.shareStatus.portalRunning ? 'Online' : 'Offline'}</b></span><span>Firewall <b>{selected.hosted.shareStatus.firewall ?? 'unused'}</b></span><span>Gateway <b>{selected.hosted.shareStatus.gateway ?? 'disabled'}</b></span><span>Certificate <b>{selected.hosted.shareStatus.certificate ?? 'unused'}</b></span>{selected.hosted.shareStatus.secureGameEndpoint && <span>Secure game <b>{selected.hosted.shareStatus.secureGameEndpoint}</b></span>}{selected.hosted.shareStatus.compatibilityGameEndpoint && <span>Legacy web clients <b>{selected.hosted.shareStatus.compatibilityGameEndpoint}</b></span>}<span>Mapping <b>{selected.hosted.shareStatus.mapping}</b></span><span>Reachability <b>{selected.hosted.shareStatus.reachability}</b></span>{(selected.hosted.shareStatus.gatewayError || selected.hosted.shareStatus.error) && <span className="share-error">{selected.hosted.shareStatus.gatewayError || selected.hosted.shareStatus.error}</span>}</div><div className="shared-slots"><strong>Download permissions</strong><span className="shared-slots-note">{selected.hosted.shareStatus.portalRunning ? 'Stop sharing to change download permissions.' : 'All room slots stay visible; choose which patches guests can download.'}</span>{selected.slots.filter((slot) => slot.files.some((file) => ['downloaded', 'imported'].includes(file.kind))).map((slot) => <label key={slot.slot}><input type="checkbox" checked={selected.hosted!.sharedSlots.includes(slot.slot)} disabled={selected.hosted!.shareStatus.portalRunning} onChange={() => updateHosted(selected, { sharedSlots: selected.hosted!.sharedSlots.includes(slot.slot) ? selected.hosted!.sharedSlots.filter((value) => value !== slot.slot) : [...selected.hosted!.sharedSlots, slot.slot] })} /><span className="custom-check">{selected.hosted!.sharedSlots.includes(slot.slot) && <Check size={11} />}</span>{slot.name} · {slot.game}</label>)}</div>{selected.hosted.shareStatus.portalRunning && <div className="invite-actions"><button className="secondary-button" onClick={() => void copyInvite(selected, 'browser')}><Clipboard size={14} />Browser invite</button><button className="secondary-button" onClick={() => void copyInvite(selected, 'controller')}><Clipboard size={14} />Controller invite</button>{selected.hosted.shareStatus.secureGameEndpoint && <button className="secondary-button" onClick={() => void copySecureEndpoint(selected)}><Clipboard size={14} />Secure game</button>}<span>{selected.hosted.shareStatus.publicUrl}</span></div>}</section>}
        {selected.provider?.type === 'local' && selected.hosted && <div className="room-remote-wake"><label><input type="checkbox" checked={Boolean(selected.hosted.allowRemoteWake)} disabled={selected.hosted.shareStatus.portalRunning} onChange={(event) => updateHosted(selected, { allowRemoteWake: event.target.checked })} /><span className="custom-check">{selected.hosted.allowRemoteWake && <Check size={11} />}</span><span><strong>Allow remote wake</strong><small>Anyone with the random room URL may start this room while sharing remains online.</small></span></label></div>}
        {selected.provider?.type === 'controller' && selected.status.capabilities?.remoteWake && !selected.status.endpoint && <div className="room-remote-wake"><span><strong>The game server is offline</strong><small>This host allows participants to request a wake.</small></span><button className="secondary-button" disabled={busy === `wake:${selected.id}`} onClick={() => void wakeControllerRoom(selected)}><Power size={14} />Wake room</button></div>}
        {!universalTrackerInstalled && <section className="room-tool-install"><Radar size={20} /><span><strong>Universal Tracker is not installed</strong><small>Install the newest compatible indexed release to calculate in-logic and glitched checks for your slots.</small></span><button className="secondary-button" disabled={busy === 'install:tracker'} onClick={() => void installRoomTool('tracker')}>{busy === 'install:tracker' ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}Install Universal Tracker</button></section>}
        {slotLockRequired && !slotLockInstalled && <section className="room-tool-install"><Gamepad2 size={20} /><span><strong>SlotLock client is not installed</strong><small>This room contains a SlotLock controller. Install its newest compatible indexed release to open the slot-specific client.</small></span><button className="secondary-button" disabled={busy === 'install:slotlock'} onClick={() => void installRoomTool('slotlock')}>{busy === 'install:slotlock' ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}Install SlotLock</button></section>}
        <section className="room-live-progress">
          <div className="room-live-heading"><div><Activity size={17} /><span><strong>Live room progress</strong><small>{trackerDashboard ? `Updated ${compactDate(trackerDashboard.refreshedAt)}` : 'Checks, goals, activity, hints, spheres, and files'}</small></span></div><div className="room-live-actions"><div className="room-live-tabs"><button className={trackerTab === 'progress' ? 'active' : ''} onClick={() => setTrackerTab('progress')}>Progress</button><button className={trackerTab === 'hints' ? 'active' : ''} onClick={() => setTrackerTab('hints')}>Hints{trackerDashboard?.unresolvedHints ? <b>{trackerDashboard.unresolvedHints}</b> : null}</button><button className={trackerTab === 'activity' ? 'active' : ''} onClick={() => setTrackerTab('activity')}>Activity</button><button className={trackerTab === 'spheres' ? 'active' : ''} onClick={() => setTrackerTab('spheres')}>Spheres</button><button className={trackerTab === 'downloads' ? 'active' : ''} onClick={() => setTrackerTab('downloads')}>Downloads</button></div><button className="icon-button" title="Refresh tracker data" disabled={trackerBusy || (!selected.status.trackerId && !selected.status.capabilities?.progress && !(selected.provider?.type === 'local' && hostRunning && activeHostRoomId === selected.id))} onClick={() => void loadTrackerDashboard(selected)}>{trackerBusy ? <LoaderCircle className="spin" size={14} /> : <RefreshCcw size={14} />}</button>{(selected.status.trackerId || selected.status.capabilities?.browserTrackers || selected.provider?.type === 'local') && <><button className="secondary-button" onClick={() => void tracker(selected)}><MapIcon size={14} />Multiworld</button><button className="secondary-button" disabled={!selected.status.trackerId && !selected.status.capabilities?.spheres && selected.provider?.type !== 'local'} onClick={() => void sphereTracker(selected)}><Radar size={14} />Spheres</button></>}</div></div>
          {trackerDashboard && (trackerTab === 'progress' || trackerTab === 'hints') ? <>
            <div className="room-live-stats"><span><strong>{trackerDashboard.checksDone.toLocaleString()}</strong><small>of {trackerDashboard.checksTotal.toLocaleString()} checks</small></span><span><strong>{trackerDashboard.completedPlayers}</strong><small>of {trackerDashboard.players.length} finished</small></span><span><strong>{trackerDashboard.players.reduce((sum, player) => sum + player.itemsReceived, 0).toLocaleString()}</strong><small>items received</small></span><span><strong>{trackerDashboard.unresolvedHints}</strong><small>open hints</small></span></div>
            {trackerTab === 'progress' ? <div className="room-progress-table"><div className="room-progress-filters"><Search size={13} /><input value={playerFilter} onChange={(event) => setPlayerFilter(event.target.value)} placeholder="Filter players or games" /><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="connected">Connected</option><option value="goal">Goal</option><option value="disconnected">Disconnected</option></select></div>
              <div className="room-progress-head"><button onClick={() => sortPlayers('name')}>Player</button><button onClick={() => sortPlayers('checks')}>Checks</button><button onClick={() => sortPlayers('items')}>Items</button><button onClick={() => sortPlayers('status')}>Status</button><button onClick={() => sortPlayers('activity')}>Last activity</button><span>Logic</span></div>
              {sortedTrackerPlayers.map((player) => {
                const slot = selected.slots.find((item) => item.slot === player.slot);
                const mine = Boolean(slot?.mine);
                const logic = logicBySlot[player.slot];
                const logicTemplate = templates.find((item) => item.game.trim().toLocaleLowerCase() === player.game.trim().toLocaleLowerCase());
                const currentEnvironment = logicEnvironmentByGame[player.game.trim().toLocaleLowerCase()];
                const logicStale = Boolean(logic?.stale || (logic?.stateFingerprint && logic.stateFingerprint !== currentTrackerFingerprint) || (logic?.yamlFingerprint && logicTemplate && logic.yamlFingerprint !== validationFingerprint(logicTemplate.content)) || (logic?.environmentFingerprint && currentEnvironment && logic.environmentFingerprint !== currentEnvironment));
                const percent = player.checksTotal ? Math.round(player.checksDone / player.checksTotal * 100) : 0;
                return <div className={`room-progress-row ${mine ? 'mine' : ''}`} key={player.slot}>
                  <span className="room-progress-player"><i className="game-token">{player.game.slice(0, 2).toUpperCase()}</i><span><strong>{player.alias || player.name}</strong><small>{player.game}{player.alias ? ` · ${player.name}` : ''}</small></span></span>
                  <span className="room-check-progress"><span><b>{player.checksDone}</b> / {player.checksTotal}</span><i><b style={{ width: `${percent}%` }} /></i></span>
                  <span>{player.itemsReceived}</span><span><em className={`room-player-status status-${player.status}`}>{player.statusLabel}</em></span><span>{compactDate(player.lastActivity)}</span>
                  <span>{mine && slot ? <span className="room-logic-actions">
                    {logic && <span className={`room-logic-counts ${logicStale ? 'stale' : ''}`} title={`${logicStale ? 'Stale · ' : ''}Analyzed ${compactDate(logic.analyzedAt)}`}><b>{logic.inLogic}</b> logic <b>{logic.glitched}</b> glitch{logicStale ? ' · stale' : ''}</span>}
                    {busy === `analyze:${slot.slot}`
                      ? <button className="text-button danger" onClick={() => void cancelUniversalTracker(selected, slot)}><CircleX size={13} />Cancel</button>
                      : <button className="text-button" disabled={!universalTrackerInstalled} onClick={() => void analyzeUniversalTracker(selected, slot)}><Activity size={13} />{logic ? 'Recalculate' : 'Analyze'}</button>}
                    <button className="icon-button" title="Open Universal Tracker for authoritative Go Mode" disabled={busy === `universal:${slot.slot}` || !universalTrackerInstalled} onClick={() => void launchUniversalTracker(selected, slot)}>{busy === `universal:${slot.slot}` ? <LoaderCircle className="spin" size={13} /> : <Radar size={13} />}</button>
                  </span> : <small>{player.unresolvedHintCount ? `${player.unresolvedHintCount} open hints` : 'Room slot'}</small>}</span>
                </div>;
              })}
            </div>
              : <div className="room-hints"><div className="room-hints-toolbar"><span>{visibleHints.length} {showFoundHints ? 'total' : 'unresolved'} hints</span><select value={hintSlotFilter} onChange={(event) => setHintSlotFilter(Number(event.target.value))}><option value={0}>All players</option>{trackerDashboard.players.map((player) => <option key={player.slot} value={player.slot}>{player.alias || player.name}</option>)}</select><label><input type="checkbox" checked={showFoundHints} onChange={(event) => setShowFoundHints(event.target.checked)} /><span className="custom-check">{showFoundHints && <Check size={11} />}</span>Show found</label></div>{visibleHints.length ? <div className="room-hints-table"><div className="room-hint-head"><span>Item</span><span>For</span><span>Location</span><span>Found by</span><span>Status</span></div>{visibleHints.map((hint) => <div className={`room-hint-row ${hint.found ? 'found' : ''}`} key={`${hint.receivingSlot}:${hint.findingSlot}:${hint.locationId}:${hint.itemId}`}><span><Lightbulb size={13} /><span><strong>{hint.item}</strong><small>{hint.classification}</small></span></span><span>{hint.receivingName}</span><span>{hint.location}{hint.entrance ? <small> via {hint.entrance}</small> : null}</span><span>{hint.findingName}</span><span><em className={`hint-status hint-${hint.status}`}>{hint.statusLabel}</em></span></div>)}</div> : <div className="room-no-hints"><Check size={18} /><span>No matching hints.</span></div>}</div>}
          </> : (trackerTab === 'progress' || trackerTab === 'hints') ? <div className="room-tracker-unavailable"><Radar size={20} /><span><strong>Detailed tracker data unavailable</strong><small>{trackerError || 'Refresh the room after its tracker becomes available.'}</small></span></div> : null}
          {trackerTab === 'activity' && <div className="room-activity-list">{roomActivity.length ? roomActivity.map((event) => <div key={event.id}><time>{compactDate(event.timestamp)}</time><strong>{event.type}</strong><span>{event.message}</span></div>) : <div className="room-tracker-unavailable"><Activity size={20} /><span><strong>No room activity recorded</strong><small>Connection, check, item, and goal events will appear here while the host is running.</small></span></div>}</div>}
          {trackerTab === 'spheres' && <div className="room-sphere-list">{roomSpheres?.available ? roomSpheres.checks.map((check) => <div key={`${check.sphere}:${check.finderSlot}:${check.locationId}`}><b>Sphere {check.sphere}</b><span>{check.location} · {check.finderName} ({check.finderGame})</span><span>{check.item} → {check.receiverName} ({check.receiverGame})</span></div>) : <div className="room-tracker-unavailable"><Radar size={20} /><span><strong>Sphere data unavailable</strong><small>{roomSpheres?.reason === 'old-seed' ? 'This seed predates static sphere data.' : roomSpheres?.reason === 'malformed' ? 'The multidata could not be decoded safely.' : roomSpheres?.reason === 'incompatible' ? 'This multidata format is not supported.' : 'This host has not published checked-location sphere data.'}</small></span></div>}</div>}
          {trackerTab === 'downloads' && <div className="room-download-panel"><div className="room-download-toolbar"><span><b>{selectedDownloadCount}</b> of {remoteDownloads.length} selected</span><button className="text-button" onClick={() => setSelectedDownloads(Object.fromEntries(remoteDownloads.map(({ slot, file }) => [`${slot.slot}:${file.id}`, true])))}>Select all</button><button className="text-button" disabled={!selectedDownloadCount} onClick={() => setSelectedDownloads({})}>Clear</button><button className="secondary-button" disabled={!selectedDownloadCount || busy.startsWith('download:')} onClick={() => void downloadSelection(selected)}><Download size={13} />Download selected</button><button className="secondary-button" disabled={!remoteDownloads.length || busy.startsWith('download:')} onClick={() => void downloadSelection(selected, true)}><Download size={13} />Download all</button></div><div className="room-download-list">{remoteDownloads.map(({ slot, file }) => {
            const progress = progressFor(file.id);
            const percent = progress?.[1].total ? Math.round(progress[1].received / progress[1].total * 100) : undefined;
            const selectionKey = `${slot.slot}:${file.id}`;
            return <div key={selectionKey}><label className="room-download-select"><input type="checkbox" checked={Boolean(selectedDownloads[selectionKey])} onChange={(event) => setSelectedDownloads((current) => ({ ...current, [selectionKey]: event.target.checked }))} /><span className="custom-check">{selectedDownloads[selectionKey] && <Check size={11} />}</span></label><span><strong>{file.name}</strong><small>{slot.name} · {slot.game} · {file.downloadedFileId ? 'Downloaded · ' : ''}{progress ? `${sizeLabel(progress[1].received)}${percent === undefined ? '' : ` · ${percent}%`}` : sizeLabel(file.size)}</small></span>{progress ? <button className="secondary-button" onClick={() => void window.archipelago?.cancelRoomDownload(progress[0])}><CircleX size={13} />Cancel</button> : <button className="secondary-button" disabled={busy === `download:${slot.slot}`} onClick={() => void download(selected, slot, [file.id])}><Download size={13} />{file.downloadedFileId ? 'Redownload' : 'Download'}</button>}</div>;
          })}</div></div>}
        </section>
        <div className="room-summary"><span><strong>{mineSlots.length}</strong> my slots</span><span><strong>{selected.slots.length}</strong> room players</span><button className="text-button" onClick={() => setManagingSlots(!managingSlots)}><UsersRound size={14} />{managingSlots ? 'Done' : 'Manage slots'}</button></div>
        {managingSlots && <div className="room-manage-slots">{selected.slots.map((slot) => <label key={slot.slot}><input type="checkbox" checked={slot.mine} onChange={() => updateSlot(selected, slot.slot, { mine: !slot.mine })} /><span className="custom-check">{slot.mine && <Check size={11} />}</span><span><strong>{slot.name}</strong><small>{slot.game}</small></span></label>)}</div>}
        <div className="room-slot-table"><div className="room-slot-head"><span>Slot</span><span>Files</span><span>Connection</span><span>Actions</span></div>{mineSlots.map((slot) => {
          const sources = slot.files.filter((file) => ['downloaded', 'imported'].includes(file.kind));
          const latest = slot.files.filter((file) => ['prepared', 'generated'].includes(file.kind)).at(-1);
          const trackerAssociation = associationFor(slot.game);
          const trackerPack = popTrackerPacks.find((pack) => pack.uid === trackerAssociation?.packUid);
          const savedLaunchProfile = launchProfiles[launchProfileKey(slot.game)];
          const launchProfile = savedLaunchProfile ?? (slot.game.trim().toLocaleLowerCase() === 'minecraft' && minecraft?.launcherPath && minecraft.profiles.length ? {
            id: 'detected-minecraft-neoforge', game: slot.game, label: 'Minecraft · NeoForge', primary: minecraftLaunchAction(minecraft), updatedAt: new Date(0).toISOString(),
          } : undefined);
          const apClient = clientFor(slot.game);
          const manualCompanion = launchProfile?.companion && launchProfile.companionMode === 'manual';
          const startLabel = launchProfile?.primary.type === 'minecraft' ? 'Open launcher' : launchProfile ? 'Start' : slot.game.trim().toLocaleLowerCase() === 'minecraft' ? 'Set up launcher' : 'Set up';
          return <article className={`room-slot-row ${configuringTracker === slot.slot ? 'configuring-tracker' : ''} ${configuringLaunch === slot.slot ? 'configuring-launch' : ''}`} key={slot.slot}><div className="room-slot-name"><span className="game-token">{slot.game.slice(0, 2).toUpperCase()}</span><span><strong>{slot.name}</strong><small>{slot.game} · Slot {slot.slot}</small></span></div><div className="room-file-cell">{sources.length ? <select value={chosenFiles[slot.slot] ?? sources[0].id} onChange={(event) => setChosenFiles({ ...chosenFiles, [slot.slot]: event.target.value })}>{sources.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}</select> : <span>No patch added</span>}<small>{latest ? `Prepared: ${latest.name}` : sources[0] ? `${sizeLabel(sources[0].size)} · source protected` : launchProfile ? launchProfile.label : 'Download a patch or set up startup'}</small></div><div className="room-connection-cell"><strong>{endpointLabel(selected)}</strong><small>{apClient ? apClient.displayName : launchProfile ? launchProfile.label : trackerPack ? `${trackerPack.name} · ${trackerPack.version}` : selected.passwordSet ? 'Password saved · Full auto-login' : 'Archipelago client available'}</small></div><div className="room-row-actions">{slot.downloadAvailable && selected.provider?.type !== 'local' && <button className="icon-button" title="Download slot file" disabled={busy === `download:${slot.slot}`} onClick={() => void download(selected, slot)}><Download size={15} /></button>}<button className="icon-button" title="Add patch, ROM, or companion file" onClick={() => void importFile(selected, slot)}><FilePlus2 size={15} /></button>{sources.length > 0 && <button className="primary-button room-patch-button" title="Prepare the patch with the current room port and open it" disabled={busy === `play:${slot.slot}`} onClick={() => void launchFile(selected, slot)}>{busy === `play:${slot.slot}` ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}Open patch</button>}{(!sources.length || launchProfile) && <button className={`${sources.length ? 'secondary-button' : 'primary-button'} room-start-button`} disabled={busy === `launch:${slot.slot}`} onClick={() => void startGame(selected, slot, launchProfile)}>{busy === `launch:${slot.slot}` ? <LoaderCircle className="spin" size={14} /> : <Rocket size={14} />}{startLabel}</button>}{manualCompanion && <button className="secondary-button room-companion-button" disabled={busy === `companion:${slot.slot}`} onClick={() => void startGame(selected, slot, launchProfile, 'companion')}>{busy === `companion:${slot.slot}` ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{launchProfile.companionLabel || 'Run companion'}</button>}{(sources.length > 0 || launchProfile) && <button className="icon-button" title={savedLaunchProfile ? 'Edit custom game startup' : 'Set up optional custom game startup'} onClick={() => setConfiguringLaunch(configuringLaunch === slot.slot ? undefined : slot.slot)}><Rocket size={15} /></button>}<button className="secondary-button room-client-button" title={apClient ? `Open and connect ${apClient.displayName}` : 'Open and connect the appropriate Archipelago client'} onClick={() => void launchClient(selected, slot)}><Gamepad2 size={14} />{apClient?.displayName ?? 'AP client'}</button><button className="secondary-button" disabled={!settings.popTrackerPath || busy === `tracker:${slot.slot}`} onClick={() => void launchPopTracker(selected, slot)}><MapIcon size={14} />{trackerAssociation ? 'Tracker' : 'Choose tracker'}</button><button className="icon-button" title="Choose PopTracker pack" onClick={() => setConfiguringTracker(configuringTracker === slot.slot ? undefined : slot.slot)}><SlidersHorizontal size={15} /></button><button className="icon-button" title="Open integrated console" onClick={() => void connect(selected, slot)}><MessageSquareText size={15} /></button>{selected.status.trackerId && <button className="icon-button" title="Open web tracker" onClick={() => void tracker(selected, slot)}><ExternalLink size={15} /></button>}</div>{configuringTracker === slot.slot && <div className="room-tracker-config"><label>PopTracker pack<select value={trackerAssociation?.packUid ?? ''} onChange={(event) => { const pack = popTrackerPacks.find((item) => item.uid === event.target.value); const variant = pack?.variants.find((item) => item.supportsAp); setAssociation(slot.game, pack && variant ? { packUid: pack.uid, variant: variant.id } : undefined); }}><option value="">No association</option>{popTrackerPacks.map((pack) => <option key={pack.uid} value={pack.uid}>{pack.gameName} · {pack.name}</option>)}</select></label><label>Variant<select disabled={!trackerPack} value={trackerAssociation?.variant ?? ''} onChange={(event) => trackerPack && setAssociation(slot.game, { packUid: trackerPack.uid, variant: event.target.value })}>{trackerPack?.variants.filter((variant) => variant.supportsAp).map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}</select></label><button className="secondary-button" disabled={!trackerAssociation} onClick={() => void launchPopTracker(selected, slot)}><MapIcon size={14} />Open & connect</button></div>}{configuringLaunch === slot.slot && <LaunchProfileEditor game={slot.game} slot={slot.name} roomUrl={selected.url} endpoint={endpointLabel(selected)} existing={savedLaunchProfile} minecraft={minecraft} onSave={saveLaunchProfile} onRemove={() => removeLaunchProfile(slot.game)} onCancel={() => setConfiguringLaunch(undefined)} onStart={(profile) => void startGame(selected, slot, profile)} />}</article>;
        })}</div>
        {!mineSlots.length && <div className="room-empty"><UsersRound size={24} /><strong>No slots selected</strong><span>Forget and re-add this room to choose the slots you play.</span></div>}
      </> : <div className="room-empty"><Link size={26} /><strong>No saved rooms</strong><span>Add an archipelago.gg room link to keep its changing port, patches, and trackers together.</span><button className="primary-button" onClick={() => setAdding(true)}><Plus size={15} />Add room</button></div>}
    </section>
  </div>;
}
