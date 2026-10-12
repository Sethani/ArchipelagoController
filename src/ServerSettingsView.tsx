import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, FileCode2, FolderSync, Save, Search, Server, Trash2, X } from 'lucide-react';
import { parse, stringify } from 'yaml';
import type { HostSettings } from './types';
import { hostDocument } from './lib/session';

type Props = {
  host: HostSettings;
  installRoot: string;
  setHost: (host: HostSettings) => void;
  notify: (message: string) => void;
};

type Leaf = { path: string[]; value: unknown };

export type GameSettingsTarget = { game: string; worldIds?: string[] };

const GLOBAL_SECTIONS = new Set(['general_options', 'server_options', 'generator', 'sni_options', 'bizhawkclient_options']);
const GAME_SECTION_ALIASES: Record<string, string> = {
  'a link to the past': 'lttp_options', 'age of empires ii de': 'age2de_options', 'castlevania 64': 'cv64_options',
  'castlevania circle of the moon': 'cvcotm_options', 'donkey kong country 3': 'dkc3_options', 'final fantasy': 'ffr_options',
  'hollow knight': 'hk_options', 'jak and daxter the precursor legacy': 'jakanddaxter_options', 'kirbys dream land 3': 'kdl3_options',
  'links awakening dx': 'ladx_options', 'lufia ii ancient cave': 'lufia2ac_options', 'mario and luigi superstar saga': 'mlss_options',
  'mega man 2': 'mm2_options', 'mega man 3': 'mm3_options', 'mega man battle network 3': 'mmbn3_options',
  'ocarina of time': 'oot_options', 'pokemon red and blue': 'pokemon_rb_options', 'starcraft 2': 'sc2_options',
  'super mario land 2': 'sml2_options', 'super mario world': 'smw_options', 'super metroid': 'sm_options',
  'the legend of zelda': 'tloz_options', 'the messenger': 'messenger_settings', 'the minish cap': 'tmc_options',
  'yoshis island': 'yoshisisland_options', 'yu gi oh 2006': 'yugioh06_settings',
};

const normalizeIdentity = (value: string) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

export function findGameHostSections(document: Record<string, unknown>, game: string, worldIds: string[] = []) {
  const available = Object.keys(document).filter((key) => !GLOBAL_SECTIONS.has(key));
  const exactCandidates = worldIds.flatMap((id) => [`${id}_options`, `${id}_settings`, id]).map((value) => value.toLowerCase());
  const matches = available.filter((key) => exactCandidates.includes(key.toLowerCase()));
  const alias = GAME_SECTION_ALIASES[normalizeIdentity(game)];
  if (alias && available.includes(alias) && !matches.includes(alias)) matches.push(alias);
  const normalizedGame = normalizeIdentity(game);
  for (const key of available) {
    const base = key.replace(/_(?:options|settings)$/i, '');
    if (normalizeIdentity(base) === normalizedGame && !matches.includes(key)) matches.push(key);
  }
  return matches;
}

const CHOICES: Record<string, string[]> = {
  'server_options.loglevel': ['debug', 'info', 'warning', 'error', 'critical'],
  'server_options.release_mode': ['disabled', 'enabled', 'auto', 'auto-enabled', 'goal'],
  'server_options.collect_mode': ['disabled', 'enabled', 'auto', 'auto-enabled', 'goal'],
  'server_options.remaining_mode': ['disabled', 'enabled', 'goal'],
  'server_options.countdown_mode': ['disabled', 'enabled', 'auto'],
  'generator.loglevel': ['debug', 'info', 'warning', 'error', 'critical'],
  'generator.panic_method': ['raise', 'swap', 'start_inventory'],
  'minecraft_options.release_channel': ['release', 'beta'],
  'universal_tracker.enforce_deferred_entrances': ['on', 'default', 'off'],
  'universal_tracker.sorting_method': ['location', 'region', 'label', 'apworld'],
};

const DESCRIPTIONS: Record<string, string> = {
  'server_options.host': 'Network interface to bind. Empty uses the Archipelago default.',
  'server_options.port': 'Port players use to connect to this server.',
  'server_options.multidata': 'Optional generated multidata file used when starting the server directly.',
  'server_options.savefile': 'Optional path or name for server progress saves.',
  'server_options.disable_save': 'Prevent the server from writing progress saves.',
  'server_options.disable_item_cheat': 'Disallow the player !getitem command.',
  'server_options.location_check_points': 'Hint points awarded for each acquired item in a player world.',
  'server_options.hint_cost': 'Percentage of available checks charged for a hint.',
  'server_options.auto_shutdown': 'Seconds without new checks before shutdown. Zero keeps running.',
  'server_options.compatibility': 'Two favors broad compatibility; zero requires exact versions.',
  'server_options.log_network': 'Log raw server traffic for diagnostics.',
  'server_options.loglevel': 'Minimum severity written to the server log.',
  'server_options.logtime': 'Prefix server log entries with their time.',
  'generator.players': 'Number of players. Zero infers the count from player YAML files.',
  'generator.spoiler': 'Spoiler detail from zero (none) through three (full paths).',
  'generator.race': 'Create encrypted race outputs where supported.',
  'generator.loglevel': 'Minimum severity written to the generation log.',
  'generator.logtime': 'Prefix generation log entries with their time.',
  'factorio_options.executable': 'Path to the Factorio executable, relative to Archipelago or absolute.',
  'ffr_options.display_msgs': 'Display received-item messages in the game client.',
  'messenger_settings.game_path': 'Path to The Messenger executable.',
  'minecraft_options.max_heap_size': 'Maximum memory assigned to the Minecraft server JVM.',
  'minecraft_options.min_heap_size': 'Initial memory assigned to the Minecraft server JVM.',
  'mlss_options.rom_start': 'Automatically open the patched ROM after it is created.',
  'pokemon_rb_options.blue_rom_file': 'File name or path for the supported Pokemon Blue ROM.',
  'tmc_options.rom_start': 'Automatically open the patched ROM after it is created.',
};

const CORE_PATHS = new Set(['server_options.host', 'server_options.port', 'server_options.savefile', 'server_options.auto_shutdown', 'server_options.loglevel']);
const SECRET_PATHS = new Set(['server_options.password', 'server_options.server_password']);

function title(value: string) {
  const special: Record<string, string> = {
    server_options: 'Server', general_options: 'General', generator: 'Generation', sni_options: 'SNI', bizhawkclient_options: 'BizHawk Client',
    age2de_options: 'Age of Empires II: DE', cv64_options: 'Castlevania 64', cvcotm_options: 'Castlevania: Circle of the Moon',
    dkc3_options: 'Donkey Kong Country 3', ffr_options: 'Final Fantasy', hk_options: 'Hollow Knight', jakanddaxter_options: 'Jak and Daxter',
    kdl3_options: "Kirby's Dream Land 3", ladx_options: "Link's Awakening DX", lttp_options: 'A Link to the Past', lufia2ac_options: 'Lufia II Ancient Cave',
    messenger_settings: 'The Messenger', mlss_options: 'Mario & Luigi: Superstar Saga', mm2_options: 'Mega Man 2', mm3_options: 'Mega Man 3',
    mmbn3_options: 'Mega Man Battle Network 3', oot_options: 'Ocarina of Time', pokemon_rb_options: 'Pokemon Red & Blue',
    sc2_options: 'StarCraft 2', sm_options: 'Super Metroid', sml2_options: 'Super Mario Land 2', smw_options: 'Super Mario World',
    soe_options: 'Secret of Evermore', stardew_valley_options: 'Stardew Valley', tloz_options: 'The Legend of Zelda', tmc_options: 'The Minish Cap',
    universal_tracker: 'Universal Tracker', yoshisisland_options: "Yoshi's Island", yugioh06_settings: 'Yu-Gi-Oh! 2006',
  };
  const result = special[value] ?? value.replace(/_(?:options|settings)$/i, '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  return result.replace(/\bRom\b/g, 'ROM').replace(/\bSni\b/g, 'SNI');
}

function flatten(value: unknown, path: string[] = []): Leaf[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length) return entries.flatMap(([key, item]) => flatten(item, [...path, key]));
  }
  return [{ path, value }];
}

function setPath(document: Record<string, unknown>, path: string[], value: unknown) {
  const copy = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  let current = copy;
  path.slice(0, -1).forEach((key) => {
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  });
  current[path.at(-1)!] = value;
  return copy;
}

function hydrateHost(current: HostSettings, document: Record<string, unknown>, comments = current.comments): HostSettings {
  const server = document.server_options && typeof document.server_options === 'object' && !Array.isArray(document.server_options)
    ? document.server_options as Record<string, unknown> : {};
  return {
    ...current,
    host: typeof server.host === 'string' ? server.host : '',
    port: typeof server.port === 'number' ? server.port : current.port,
    savefile: typeof server.savefile === 'string' ? server.savefile : '',
    autoShutdown: typeof server.auto_shutdown === 'number' ? server.auto_shutdown : current.autoShutdown,
    logLevel: typeof server.loglevel === 'string' ? server.loglevel : current.logLevel,
    raw: '',
    document,
    comments,
  };
}

function ComplexEditor({ value, onChange }: { value: unknown[] | Record<string, unknown>; onChange: (value: unknown) => void }) {
  const [draft, setDraft] = useState(() => stringify(value).trim());
  useEffect(() => setDraft(stringify(value).trim()), [value]);
  const commit = () => {
    try {
      const next = parse(draft);
      if ((Array.isArray(value) && Array.isArray(next)) || (!Array.isArray(value) && next && typeof next === 'object' && !Array.isArray(next))) onChange(next);
    } catch { /* Keep the draft until it becomes valid. */ }
  };
  return <textarea className="yaml-complex-input" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} spellCheck={false} />;
}

function YamlControl({ option, onChange }: { option: Leaf; onChange: (value: unknown) => void }) {
  const key = option.path.join('.');
  const value = option.value;
  if (key === 'generator.plando_options') {
    const available = ['bosses', 'items', 'texts', 'connections'];
    const selected = new Set(String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean));
    return <div className="yaml-checkbox-group">{available.map((item) => <label key={item}><input type="checkbox" checked={selected.has(item)} onChange={(event) => {
      const next = new Set(selected);
      if (event.target.checked) next.add(item); else next.delete(item);
      onChange(available.filter((choice) => next.has(choice)).join(', '));
    }} /><span className="custom-check"><Check size={11} /></span>{title(item)}</label>)}</div>;
  }
  if (typeof value === 'boolean') return <label className="yaml-toggle"><input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /><span className="toggle-track"><span /></span><em>{value ? 'Enabled' : 'Disabled'}</em></label>;
  if (typeof value === 'number') return <input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />;
  if (Array.isArray(value) || (value && typeof value === 'object')) return <ComplexEditor value={value as unknown[] | Record<string, unknown>} onChange={onChange} />;
  if (CHOICES[key]) return <select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>{CHOICES[key].map((choice) => <option key={choice}>{choice}</option>)}</select>;
  return <input value={value === null ? '' : String(value)} placeholder={value === null ? 'Archipelago default' : ''} onChange={(event) => onChange(event.target.value || (value === null ? null : ''))} />;
}

function SecureOption({ label, id, configured, setConfigured }: { label: string; id: string; configured: boolean; setConfigured: (value: boolean) => void }) {
  const [value, setValue] = useState('');
  const save = async () => {
    if (!value) return;
    await window.archipelago?.setSecret({ id, value });
    setValue('');
    setConfigured(true);
  };
  const remove = async () => {
    await window.archipelago?.removeSecret(id);
    setConfigured(false);
  };
  return <div className="yaml-option secret-option"><span><strong>{label}</strong><small>Stored securely outside host settings</small></span><div className="secret-field"><input type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder={configured ? 'Configured' : 'Not configured'} /><button className="secondary-button" disabled={!value} onClick={() => void save()}><Save size={14} />Save</button>{configured && <button className="icon-button danger" title={`Remove ${label}`} onClick={() => void remove()}><Trash2 size={14} /></button>}</div></div>;
}

export function ServerSettingsView({ host, installRoot, setHost, notify }: Props) {
  const [section, setSection] = useState('server_options');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<'loading' | 'saving' | ''>('');
  const [rawMode, setRawMode] = useState(false);
  const [rawDraft, setRawDraft] = useState('');
  const [rawError, setRawError] = useState('');
  const effective = useMemo(() => hostDocument(host), [host]);
  const sections = useMemo(() => Object.keys(effective).filter((key) => GLOBAL_SECTIONS.has(key) && effective[key] && typeof effective[key] === 'object' && !Array.isArray(effective[key])), [effective]);

  const loadInstalled = async (announce = true) => {
    if (!window.archipelago || !installRoot) return;
    setBusy('loading');
    try {
      const result = await window.archipelago.readHostConfig(installRoot);
      if (!result.ok || !result.document) throw new Error(result.error || 'Unable to read host.yaml');
      setHost(hydrateHost(host, result.document, result.comments ?? {}));
      if (announce) notify('Loaded installed host.yaml');
    } catch (error) { notify(error instanceof Error ? error.message : 'Unable to read host.yaml'); }
    finally { setBusy(''); }
  };

  useEffect(() => {
    if (!Object.keys(host.document ?? {}).length) void loadInstalled(false);
    // Loading is tied to the configured installation, not every field edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installRoot]);

  useEffect(() => {
    if (!sections.includes(section) && sections[0]) setSection(sections[0]);
  }, [section, sections]);

  const updateOption = (path: string[], value: unknown) => {
    const key = path.join('.');
    if (key === 'server_options.host') setHost({ ...host, host: String(value ?? '') });
    else if (key === 'server_options.port') setHost({ ...host, port: Number(value) });
    else if (key === 'server_options.savefile') setHost({ ...host, savefile: String(value ?? '') });
    else if (key === 'server_options.auto_shutdown') setHost({ ...host, autoShutdown: Number(value) });
    else if (key === 'server_options.loglevel') setHost({ ...host, logLevel: String(value) });
    else setHost({ ...host, document: setPath(host.document, path, value) });
  };

  const saveInstalled = async () => {
    if (!window.archipelago || !installRoot) return;
    setBusy('saving');
    try {
      const result = await window.archipelago.writeHostConfig({ installRoot, document: effective });
      if (!result.ok) throw new Error(result.error || 'Unable to write host.yaml');
      notify('Server settings applied to Archipelago');
    } catch (error) { notify(error instanceof Error ? error.message : 'Unable to write host.yaml'); }
    finally { setBusy(''); }
  };

  const openRaw = () => {
    setRawDraft(stringify(Object.fromEntries(Object.entries(effective).filter(([key]) => GLOBAL_SECTIONS.has(key)))));
    setRawError('');
    setRawMode(true);
  };
  const applyRaw = () => {
    try {
      const parsed = parse(rawDraft);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('host.yaml must contain a top-level mapping.');
      const parsedDocument = parsed as Record<string, unknown>;
      const unsupported = Object.keys(parsedDocument).find((key) => !GLOBAL_SECTIONS.has(key));
      if (unsupported) throw new Error(`${unsupported} is game-specific and belongs with its APWorld or YAML template.`);
      setHost(hydrateHost(host, { ...host.document, ...parsedDocument }));
      setRawError('');
      setRawMode(false);
      notify('YAML changes parsed');
    } catch (error) { setRawError(error instanceof Error ? error.message.split('\n')[0] : 'Invalid YAML'); }
  };

  const visibleSections = query ? sections.filter((name) => flatten(effective[name], [name]).some((item) => item.path.join(' ').replaceAll('_', ' ').toLowerCase().includes(query.toLowerCase()))) : [section];

  return <div className="page-view server-settings-view">
    <div className="page-heading"><div><h1>Server Settings</h1><p>Archipelago-wide server, generation, and shared client options</p></div><div className="heading-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void loadInstalled()}><FolderSync size={15} />Reload installed</button><button className="secondary-button" onClick={openRaw}><FileCode2 size={15} />YAML</button><button className="primary-button" disabled={Boolean(busy) || !installRoot} onClick={() => void saveInstalled()}>{busy === 'saving' ? 'Applying...' : <><Save size={15} />Apply to Archipelago</>}</button></div></div>
    <div className="server-settings-workspace">
      <aside className="server-section-nav"><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an option" /></label><div>{sections.map((name) => <button className={!query && section === name ? 'active' : ''} key={name} onClick={() => { setSection(name); setQuery(''); }}><span>{title(name)}</span><em>{flatten(effective[name], [name]).filter((item) => !SECRET_PATHS.has(item.path.join('.'))).length}</em><ChevronRight size={13} /></button>)}</div></aside>
      <main className="server-options-pane">{busy === 'loading' && !sections.length ? <div className="compact-empty">Reading installed host.yaml...</div> : visibleSections.map((name) => {
        const options = flatten(effective[name], [name]).filter((item) => !SECRET_PATHS.has(item.path.join('.')) && (!query || item.path.join(' ').replaceAll('_', ' ').toLowerCase().includes(query.toLowerCase())));
        return <section className="yaml-section" key={name}><div className="yaml-section-heading"><Server size={17} /><div><strong>{title(name)}</strong><span>{name}</span></div></div>{name === 'server_options' && <div className="yaml-options-grid secret-grid"><SecureOption label="Room password" id={host.roomPasswordRef ?? 'host:room'} configured={host.roomPasswordSet} setConfigured={(roomPasswordSet) => setHost({ ...host, roomPasswordRef: 'host:room', roomPasswordSet })} /><SecureOption label="Server admin password" id={host.serverPasswordRef ?? 'host:server'} configured={host.serverPasswordSet} setConfigured={(serverPasswordSet) => setHost({ ...host, serverPasswordRef: 'host:server', serverPasswordSet })} /></div>}<div className="yaml-options-grid">{options.map((option) => {
          const key = option.path.join('.');
          const description = host.comments?.[key] || DESCRIPTIONS[key];
          return <label className={`yaml-option ${CORE_PATHS.has(key) ? 'core' : ''}`} key={key}><span><strong>{title(option.path.at(-1)!)}</strong><code>{key}</code>{description && <small>{description}</small>}</span><YamlControl option={option} onChange={(value) => updateOption(option.path, value)} /></label>;
        })}</div></section>;
      })}</main>
    </div>
    {rawMode && <div className="dialog-backdrop"><div className="confirm-dialog yaml-dialog"><div><FileCode2 size={20} /><div><strong>Core host.yaml</strong><span>Game-specific sections remain attached to their APWorlds and templates.</span></div></div><textarea value={rawDraft} onChange={(event) => setRawDraft(event.target.value)} spellCheck={false} />{rawError && <div className="yaml-error">{rawError}</div>}<div><button className="secondary-button" onClick={() => setRawMode(false)}>Cancel</button><button className="primary-button" onClick={applyRaw}><Check size={15} />Parse changes</button></div></div></div>}
  </div>;
}

export function GameSettingsDialog({ target, host, installRoot, setHost, notify, onClose }: Props & { target: GameSettingsTarget; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const effective = useMemo(() => hostDocument(host), [host]);
  const sections = findGameHostSections(effective, target.game, target.worldIds);
  const updateOption = (path: string[], value: unknown) => setHost({ ...host, document: setPath(host.document, path, value) });
  const apply = async () => {
    if (!window.archipelago) return;
    setSaving(true);
    try {
      const result = await window.archipelago.writeHostConfig({ installRoot, document: effective });
      if (!result.ok) throw new Error(result.error || 'Unable to write host.yaml');
      notify(`${target.game} settings applied`);
      onClose();
    } catch (error) { notify(error instanceof Error ? error.message : 'Unable to write host.yaml'); }
    finally { setSaving(false); }
  };
  return <div className="dialog-backdrop" onMouseDown={onClose}><div className="confirm-dialog game-settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
    <div className="game-settings-heading"><div className="game-token">{target.game.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase()}</div><div><strong>{target.game} settings</strong><span>Client and world-specific host options</span></div><button className="icon-button" title="Close game settings" onClick={onClose}><X size={15} /></button></div>
    <div className="game-settings-body">{sections.length ? sections.map((name) => <section className="yaml-section" key={name}><div className="yaml-section-heading"><Server size={17} /><div><strong>{title(name)}</strong><span>{name}</span></div></div><div className="yaml-options-grid">{flatten(effective[name], [name]).map((option) => {
      const key = option.path.join('.');
      const description = host.comments?.[key] || DESCRIPTIONS[key];
      return <label className="yaml-option" key={key}><span><strong>{title(option.path.at(-1)!)}</strong><code>{key}</code>{description && <small>{description}</small>}</span><YamlControl option={option} onChange={(value) => updateOption(option.path, value)} /></label>;
    })}</div></section>) : <div className="game-settings-empty"><strong>No dedicated host options</strong><span>This world is configured entirely through its player YAML or its own client.</span></div>}</div>
    <div className="game-settings-actions"><button className="secondary-button" onClick={onClose}>Cancel</button>{sections.length > 0 && <button className="primary-button" disabled={saving} onClick={() => void apply()}><Save size={15} />{saving ? 'Applying...' : 'Apply to Archipelago'}</button>}</div>
  </div></div>;
}
