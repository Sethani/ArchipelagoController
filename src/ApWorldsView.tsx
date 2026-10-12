import { useEffect, useMemo, useState } from 'react';
import {
  Archive, Check, ChevronDown, Clipboard, Download, ExternalLink, FilePlus2, FolderOpen,
  Info, LoaderCircle, RefreshCcw, Search, ShieldAlert, SlidersHorizontal, Trash2, X,
} from 'lucide-react';
import type {
  ApWorldCatalogEntry, ApWorldCatalogResult, ApWorldCompatibilityStatus, ApWorldInventoryEntry,
  ApWorldInstallationStatus, ApWorldRelease, BuiltInApWorld,
} from './types';
import type { GameSettingsTarget } from './ServerSettingsView';

type Tab = 'installed' | 'catalog' | 'built-in';
type SortKey = 'game' | 'version' | 'status';
type Confirmation = { title: string; message: string; danger?: boolean; action: () => Promise<void> };

const emptyCatalog: ApWorldCatalogResult = { entries: [], sources: [], stale: true };

function versionParts(value?: string) {
  const text = String(value ?? '').trim().replace(/^v/i, '').toLowerCase();
  const coreMatch = text.match(/\d+(?:\.\d+)*/);
  const core = (coreMatch?.[0] ?? '0').split('.').map((part) => Number(part) || 0);
  const suffix = text.slice(coreMatch ? coreMatch.index! + coreMatch[0].length : 0);
  const stage = /post|rev|hotfix/.test(suffix) ? 4 : /rc/.test(suffix) ? 2 : /b(?:eta)?/.test(suffix) ? 1 : /a(?:lpha)?|dev|pre/.test(suffix) ? 0 : 3;
  return { core, stage, suffix: Number(suffix.match(/\d+/)?.[0] ?? 0), text };
}

function compareVersions(left?: string, right?: string) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference) return difference;
  }
  return a.stage - b.stage || a.suffix - b.suffix || a.text.localeCompare(b.text);
}

function compatibility(release: Pick<ApWorldRelease, 'minimumApVersion' | 'maximumApVersion'>, apVersion?: string): ApWorldCompatibilityStatus {
  if (!apVersion) return 'Unknown';
  if (release.minimumApVersion && compareVersions(apVersion, release.minimumApVersion) < 0) return 'Too old';
  if (release.maximumApVersion && compareVersions(apVersion, release.maximumApVersion) > 0) return 'Too new';
  return 'Compatible';
}

function bestRelease(entry: ApWorldCatalogEntry, apVersion?: string, includePrerelease = false) {
  return entry.releases.find((release) => compatibility(release, apVersion) === 'Compatible' && (includePrerelease || release.channel === 'Release'));
}

function installedStatus(installed: ApWorldInventoryEntry, catalog: ApWorldCatalogEntry | undefined, apVersion?: string): ApWorldInstallationStatus {
  if (!catalog) return 'Unmanaged';
  const latest = bestRelease(catalog, apVersion);
  const matched = catalog.releases.find((release) => release.sha256 === installed.sha256);
  if (!latest) return installed.version ? 'Ahead' : 'Unknown version';
  if (matched?.id === latest.id || installed.sha256 === latest.sha256) return 'Current';
  if (!installed.version) return 'Unknown version';
  const order = compareVersions(installed.version, latest.version);
  return order < 0 ? 'Update available' : order > 0 ? 'Ahead' : 'Current';
}

function tone(value: string): 'good' | 'warn' | 'bad' | 'neutral' {
  if (['Current', 'Compatible', 'Stable', 'Release'].includes(value)) return 'good';
  if (['Update available', 'Unknown version', 'Unknown', 'Unmanaged', 'Prerelease'].includes(value)) return 'warn';
  if (['Too old', 'Too new', 'Broken on Main', 'Unready'].includes(value)) return 'bad';
  return 'neutral';
}

function Chip({ children }: { children: string }) {
  return <span className={`status-chip ${tone(children)}`}>{children}</span>;
}

function shortDate(value?: string) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function releaseCompatibilityText(release: ApWorldRelease) {
  if (release.minimumApVersion && release.maximumApVersion) return `${release.minimumApVersion} - ${release.maximumApVersion}`;
  if (release.minimumApVersion) return `${release.minimumApVersion}+`;
  if (release.maximumApVersion) return `Up to ${release.maximumApVersion}`;
  return 'No declared limit';
}

export function ApWorldsView({ installRoot, notify, openSettings, initialSearch = '', hasGameSettings, openGameSettings }: { installRoot: string; notify: (message: string) => void; openSettings: () => void; initialSearch?: string; hasGameSettings: (game: string, worldIds?: string[]) => boolean; openGameSettings: (target: GameSettingsTarget) => void }) {
  const [tab, setTab] = useState<Tab>('installed');
  const [catalog, setCatalog] = useState<ApWorldCatalogResult>(emptyCatalog);
  const [installed, setInstalled] = useState<ApWorldInventoryEntry[]>([]);
  const [builtIn, setBuiltIn] = useState<BuiltInApWorld[]>([]);
  const [apVersion, setApVersion] = useState<string>();
  const [inventoryError, setInventoryError] = useState('');
  const [search, setSearch] = useState(initialSearch);
  const [sort, setSort] = useState<SortKey>('game');
  const [selectedId, setSelectedId] = useState('');
  const [selectedReleaseId, setSelectedReleaseId] = useState('');
  const [selectedUpdates, setSelectedUpdates] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [filters, setFilters] = useState({ unstable: false, prerelease: false, adult: false, incompatible: false, unknown: false });

  const catalogById = useMemo(() => new Map(catalog.entries.map((entry) => [entry.id, entry])), [catalog.entries]);
  const installedById = useMemo(() => new Map(installed.map((entry) => [entry.id, entry])), [installed]);

  async function loadInventory() {
    if (!window.archipelago || !installRoot) return;
    const result = await window.archipelago.inventoryApWorlds(installRoot);
    setInstalled(result.installed);
    setBuiltIn(result.builtIn);
    setApVersion(result.apVersion);
    setInventoryError(result.error ?? '');
  }

  async function loadCatalog(force = false) {
    if (!window.archipelago) return;
    setBusy('catalog');
    try { setCatalog(force ? await window.archipelago.refreshApWorldCatalog() : await window.archipelago.getApWorldCatalog()); }
    catch (error) { notify(error instanceof Error ? error.message : 'Catalog refresh failed'); }
    finally { setBusy(''); }
  }

  useEffect(() => { void Promise.all([loadInventory(), loadCatalog()]); }, [installRoot]);
  useEffect(() => { if (initialSearch) { setSearch(initialSearch); setTab('catalog'); } }, [initialSearch]);

  const installedRows = useMemo(() => installed.map((item) => {
    let entry = catalogById.get(item.id);
    if (!entry && item.sha256) entry = catalog.entries.find((candidate) => candidate.releases.some((release) => release.sha256 === item.sha256));
    const latest = entry ? bestRelease(entry, apVersion) : undefined;
    return { item, entry, latest, status: installedStatus(item, entry, apVersion) };
  }), [installed, catalog.entries, catalogById, apVersion]);

  const updates = installedRows.filter((row) => row.status === 'Update available' && row.latest);

  const catalogRows = useMemo(() => catalog.entries.map((entry) => {
    const releases = entry.releases.filter((release) => filters.prerelease || release.channel === 'Release');
    const release = releases.find((item) => compatibility(item, apVersion) === 'Compatible') ?? releases[0];
    return { entry, release, compatibility: release ? compatibility(release, apVersion) : 'Unknown' as ApWorldCompatibilityStatus };
  }).filter(({ entry, release, compatibility: compatibilityState }) => {
    if (!release) return false;
    if (!filters.adult && entry.adult) return false;
    if (!filters.unstable && ['Unstable', 'Broken on Main'].includes(entry.communityStatus)) return false;
    if (!filters.unknown && entry.communityStatus === 'Unknown') return false;
    if (!filters.prerelease && release.channel !== 'Release') return false;
    if (!filters.incompatible && ['Too old', 'Too new'].includes(compatibilityState)) return false;
    if (!filters.unknown && compatibilityState === 'Unknown') return false;
    return true;
  }), [catalog.entries, apVersion, filters]);

  const query = search.trim().toLowerCase();
  const sortedInstalled = installedRows.filter(({ item }) => !query || `${item.game} ${item.id}`.toLowerCase().includes(query)).sort((a, b) => {
    if (sort === 'version') return compareVersions(b.item.version, a.item.version);
    if (sort === 'status') return a.status.localeCompare(b.status);
    return a.item.game.localeCompare(b.item.game);
  });
  const sortedCatalog = catalogRows.filter(({ entry }) => !query || `${entry.game} ${entry.id} ${entry.description}`.toLowerCase().includes(query)).sort((a, b) => {
    if (sort === 'version') return compareVersions(b.release?.version, a.release?.version);
    if (sort === 'status') return a.entry.communityStatus.localeCompare(b.entry.communityStatus);
    return a.entry.game.localeCompare(b.entry.game);
  });
  const sortedBuiltIn = builtIn.filter((item) => !query || `${item.game} ${item.id}`.toLowerCase().includes(query)).sort((a, b) => a.game.localeCompare(b.game));

  const selectedCatalog = selectedId ? catalogById.get(selectedId) : undefined;
  const selectedInstalled = selectedId ? installedById.get(selectedId) : undefined;
  const detailRelease = selectedCatalog?.releases.find((release) => release.id === selectedReleaseId) ?? (selectedCatalog ? bestRelease(selectedCatalog, apVersion, true) ?? selectedCatalog.releases[0] : undefined);

  async function runOperation(label: string, operation: () => Promise<{ ok: boolean; error?: string; warning?: string }>) {
    setBusy(label);
    try {
      const result = await operation();
      if (!result.ok) throw new Error(result.error || 'The operation failed.');
      notify(result.warning || `${label} complete`);
      await loadInventory();
    } catch (error) { notify(error instanceof Error ? error.message : 'The operation failed'); }
    finally { setBusy(''); setConfirmation(undefined); }
  }

  function confirmInstall(entry: ApWorldCatalogEntry, release: ApWorldRelease) {
    setConfirmation({
      title: installedById.has(entry.id) ? `Replace ${entry.game}?` : `Install ${entry.game}?`,
      message: `${release.version} from ${entry.sourceUrl || 'the APWorld Index'}. APWorlds contain executable Python code. The package will be checksum-verified before installation.`,
      action: () => runOperation('Installation', () => window.archipelago!.installApWorld({ installRoot, worldId: entry.id, releaseId: release.id })),
    });
  }

  async function pickImport() {
    const sourcePath = await window.archipelago?.pickApWorld();
    if (!sourcePath) return;
    setConfirmation({
      title: 'Import local APWorld?',
      message: 'Local APWorlds contain executable Python code and may not be indexed or checksum-verified. The package structure will be validated before installation.',
      action: () => runOperation('Import', () => window.archipelago!.importApWorld({ installRoot, sourcePath })),
    });
  }

  function confirmRemove(item: ApWorldInventoryEntry) {
    setConfirmation({
      title: `Remove ${item.game}?`, danger: true,
      message: `${item.fileName} will be moved to the Windows Recycle Bin.`,
      action: () => runOperation('Removal', () => window.archipelago!.removeApWorld({ installRoot, worldId: item.id })),
    });
  }

  function updateSelected() {
    const targets = updates.filter((row) => selectedUpdates.includes(row.item.id));
    if (!targets.length) return;
    setConfirmation({
      title: `Update ${targets.length} APWorld${targets.length === 1 ? '' : 's'}?`,
      message: 'Each replacement will be downloaded and checksum-verified. Previous packages go to the Recycle Bin after successful installation.',
      action: async () => {
        setBusy('Updates');
        let completed = 0;
        for (const row of targets) {
          const result = await window.archipelago!.installApWorld({ installRoot, worldId: row.entry!.id, releaseId: row.latest!.id });
          if (!result.ok) { notify(`${row.item.game}: ${result.error}`); break; }
          completed += 1;
        }
        setSelectedUpdates([]);
        setConfirmation(undefined);
        setBusy('');
        await loadInventory();
        if (completed) notify(`${completed} APWorld${completed === 1 ? '' : 's'} updated`);
      },
    });
  }

  async function copyDiagnostics(item: ApWorldInventoryEntry) {
    const entry = catalogById.get(item.id);
    await navigator.clipboard.writeText(JSON.stringify({ installed: item, catalog: entry, apVersion }, null, 2));
    notify('APWorld diagnostics copied');
  }

  if (!installRoot || inventoryError) return <div className="page-view apworlds-view"><div className="page-heading"><div><h1>APWorlds</h1><p>Custom world packages and compatibility</p></div></div><div className="apworld-empty"><ShieldAlert size={28} /><strong>Archipelago installation unavailable</strong><span>{inventoryError || 'Choose the installation folder before managing APWorlds.'}</span><button className="primary-button" onClick={openSettings}>Open Settings</button></div></div>;

  return <div className="page-view apworlds-view">
    <div className="page-heading apworld-heading">
      <div><h1>APWorlds</h1><p>Archipelago {apVersion ?? 'Unknown'} · {installed.length} custom · {updates.length} updates</p></div>
      <div className="heading-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void pickImport()}><FilePlus2 size={15} />Import file</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void loadCatalog(true)}>{busy === 'catalog' ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />}Refresh</button></div>
    </div>

    <div className="apworld-sourcebar">
      {catalog.sources.map((source) => <span key={source.source} title={source.error}><i className={source.ok ? 'source-good' : 'source-bad'} />{source.source === 'index' ? 'APWorld Index' : 'Community sheet'} · {source.ok ? shortDate(source.updatedAt) : 'Offline'}</span>)}
      {catalog.stale && <Chip>Unknown</Chip>}
      <span className="source-spacer" />
      <button className="text-button" onClick={() => window.archipelago?.openExternal('https://github.com/silasary/apworlds')}><ExternalLink size={14} />Index</button>
      <button className="text-button" onClick={() => window.archipelago?.openExternal('https://docs.google.com/spreadsheets/d/1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw/edit?gid=58422002#gid=58422002')}><ExternalLink size={14} />Status sheet</button>
    </div>

    <div className="apworld-tabs" role="tablist">
      <button className={tab === 'installed' ? 'active' : ''} onClick={() => setTab('installed')}>Installed <span>{installed.length}</span></button>
      <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>Catalog <span>{catalog.entries.length}</span></button>
      <button className={tab === 'built-in' ? 'active' : ''} onClick={() => setTab('built-in')}>Built-in <span>{builtIn.length}</span></button>
    </div>

    <div className={`apworld-workspace ${selectedCatalog || selectedInstalled ? 'with-detail' : ''}`}>
      <section className="apworld-list-pane">
        <div className="apworld-toolbar">
          <label className="apworld-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${tab}`} /></label>
          {tab === 'installed' && updates.length > 0 && <button className="secondary-button" disabled={!selectedUpdates.length || Boolean(busy)} onClick={updateSelected}><Download size={15} />Update selected ({selectedUpdates.length})</button>}
        </div>
        {tab === 'catalog' && <div className="apworld-filters">
          {([['unstable', 'Unstable / broken'], ['prerelease', 'Prerelease / unready'], ['adult', '18+ / unrated'], ['incompatible', 'Incompatible'], ['unknown', 'Unknown']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={filters[key]} onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.checked }))} /><span className="custom-check"><Check size={11} /></span>{label}</label>)}
        </div>}
        <div className="apworld-table">
          <div className="apworld-table-head"><button onClick={() => setSort('game')}>World <ChevronDown size={12} /></button><button onClick={() => setSort('version')}>Version <ChevronDown size={12} /></button><button onClick={() => setSort('status')}>Status <ChevronDown size={12} /></button><span>Compatibility</span><span className="table-actions">Actions</span></div>
          {tab === 'installed' && sortedInstalled.map(({ item, entry, latest, status }) => <div className={`apworld-table-row ${selectedId === item.id ? 'selected' : ''}`} key={item.path} onClick={() => setSelectedId(item.id)}>
            <span className="update-check" onClick={(event) => event.stopPropagation()}>{status === 'Update available' && <label><input type="checkbox" checked={selectedUpdates.includes(item.id)} onChange={() => setSelectedUpdates((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><span className="custom-check"><Check size={11} /></span></label>}</span>
            <span className="world-name"><strong>{item.game}</strong><small>{item.id}</small></span><span className="world-version">{item.version ?? 'Unknown'}{latest && status === 'Update available' && <small>→ {latest.version}</small>}</span><span><Chip>{status}</Chip></span><span><Chip>{compatibility({ minimumApVersion: item.minimumApVersion, maximumApVersion: item.maximumApVersion }, apVersion)}</Chip></span>
            <span className="row-actions"><button className="icon-button" title="Reveal package" onClick={(event) => { event.stopPropagation(); void window.archipelago?.reveal(item.path); }}><FolderOpen size={15} /></button>{entry && latest && status === 'Update available' && <button className="icon-button" title="Update" onClick={(event) => { event.stopPropagation(); confirmInstall(entry, latest); }}><Download size={15} /></button>}<button className="icon-button danger" title="Remove" onClick={(event) => { event.stopPropagation(); confirmRemove(item); }}><Trash2 size={15} /></button></span>
          </div>)}
          {tab === 'catalog' && sortedCatalog.map(({ entry, release, compatibility: compatibilityState }) => <div className={`apworld-table-row ${selectedId === entry.id ? 'selected' : ''}`} key={entry.id} onClick={() => { setSelectedId(entry.id); setSelectedReleaseId(release.id); }}>
            <span className="update-check" /><span className="world-name"><strong>{entry.game}</strong><small>{entry.description || entry.id}</small></span><span className="world-version">{release.version}<small>{shortDate(release.createdAt)}</small></span><span className="stacked-chips"><Chip>{entry.communityStatus}</Chip><Chip>{release.channel}</Chip></span><span><Chip>{compatibilityState}</Chip></span><span className="row-actions">{installedById.has(entry.id) ? <Chip>{installedStatus(installedById.get(entry.id)!, entry, apVersion)}</Chip> : <button className="primary-button compact" disabled={Boolean(busy) || compatibilityState !== 'Compatible'} onClick={(event) => { event.stopPropagation(); confirmInstall(entry, release); }}><Download size={14} />Install</button>}</span>
          </div>)}
          {tab === 'built-in' && sortedBuiltIn.map((item) => <div className="apworld-table-row built-in-row" key={item.id}><span className="update-check" /><span className="world-name"><strong>{item.game}</strong><small>{item.id}</small></span><span className="world-version">{item.version ?? `AP ${apVersion}`}</span><span><Chip>Current</Chip></span><span><Chip>Compatible</Chip></span><span className="row-actions">{hasGameSettings(item.game, [item.id]) && <button className="icon-button" title={`${item.game} settings`} onClick={() => openGameSettings({ game: item.game, worldIds: [item.id] })}><SlidersHorizontal size={14} /></button>}<button className="secondary-button" onClick={() => window.archipelago?.openExternal('https://github.com/ArchipelagoMW/Archipelago/releases')}><ExternalLink size={14} />AP releases</button></span></div>)}
          {((tab === 'installed' && !sortedInstalled.length) || (tab === 'catalog' && !sortedCatalog.length) || (tab === 'built-in' && !sortedBuiltIn.length)) && <div className="apworld-no-results"><Archive size={24} /><strong>No matching worlds</strong><span>{tab === 'catalog' ? 'Adjust the catalog filters or refresh the sources.' : 'No worlds were found in this installation.'}</span></div>}
        </div>
      </section>

      {(selectedCatalog || selectedInstalled) && <aside className="apworld-detail">
        <div className="detail-heading"><div><span className="game-token">{(selectedCatalog?.game || selectedInstalled?.game || 'AP').split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase()}</span><div><strong>{selectedCatalog?.game || selectedInstalled?.game}</strong><small>{selectedCatalog?.id || selectedInstalled?.id}</small></div></div><button className="icon-button" title="Close details" onClick={() => setSelectedId('')}><X size={16} /></button></div>
        {selectedCatalog && <>
          <p className="detail-description">{selectedCatalog.description || selectedCatalog.communityNotes || 'No catalog description available.'}</p>
          <div className="detail-badges"><Chip>{selectedCatalog.communityStatus}</Chip>{detailRelease && <Chip>{detailRelease.channel}</Chip>}{selectedCatalog.adult && <Chip>18+ / unrated</Chip>}</div>
          <label className="detail-release">Release<select value={detailRelease?.id ?? ''} onChange={(event) => setSelectedReleaseId(event.target.value)}>{selectedCatalog.releases.map((release) => <option key={release.id} value={release.id}>{release.version} · {release.channel}</option>)}</select></label>
          {detailRelease && <dl className="detail-facts"><div><dt>Archipelago</dt><dd>{releaseCompatibilityText(detailRelease)}</dd></div><div><dt>Released</dt><dd>{shortDate(detailRelease.createdAt)}</dd></div><div><dt>SHA-256</dt><dd title={detailRelease.sha256}>{detailRelease.sha256.slice(0, 16)}…</dd></div><div><dt>Authors</dt><dd>{selectedCatalog.authors.join(', ') || 'Not listed'}</dd></div>{selectedCatalog.license && <div><dt>License</dt><dd>{selectedCatalog.license}</dd></div>}{selectedCatalog.prStatus && <div><dt>PR status</dt><dd>{selectedCatalog.prStatus}</dd></div>}</dl>}
          {(selectedCatalog.communityNotes || selectedCatalog.disclosure) && <div className="detail-note"><Info size={15} /><span>{selectedCatalog.communityNotes || selectedCatalog.disclosure}</span></div>}
          <div className="detail-links">{hasGameSettings(selectedCatalog.game, [selectedCatalog.id]) && <button className="secondary-button" onClick={() => openGameSettings({ game: selectedCatalog.game, worldIds: [selectedCatalog.id] })}><SlidersHorizontal size={14} />Settings</button>}{selectedCatalog.sourceUrl && <button className="secondary-button" onClick={() => window.archipelago?.openExternal(selectedCatalog.sourceUrl!)}><ExternalLink size={14} />Source</button>}{detailRelease && <button className="secondary-button" onClick={() => window.archipelago?.openExternal(detailRelease.releaseUrl)}><ExternalLink size={14} />Release</button>}<button className="secondary-button" onClick={() => window.archipelago?.openExternal(`https://archipelago.miraheze.org/wiki/Special:Search?search=${encodeURIComponent(selectedCatalog.game)}`)}><ExternalLink size={14} />Wiki</button>{selectedCatalog.trackerUrl && <button className="secondary-button" onClick={() => window.archipelago?.openExternal(selectedCatalog.trackerUrl!)}><ExternalLink size={14} />Tracker</button>}</div>
          {detailRelease && <button className="primary-button detail-primary" disabled={Boolean(busy) || compatibility(detailRelease, apVersion) !== 'Compatible'} onClick={() => confirmInstall(selectedCatalog, detailRelease)}><Download size={15} />{selectedInstalled ? 'Install selected version' : 'Install APWorld'}</button>}
        </>}
        {selectedInstalled && <div className="installed-detail"><div className="detail-file"><span>{selectedInstalled.fileName}</span><small>{selectedInstalled.path}</small></div>{selectedInstalled.issues.length > 0 && <div className="detail-note error"><ShieldAlert size={15} /><span>{selectedInstalled.issues.join(' ')}</span></div>}<div className="detail-links">{hasGameSettings(selectedInstalled.game, [selectedInstalled.id]) && !selectedCatalog && <button className="secondary-button" onClick={() => openGameSettings({ game: selectedInstalled.game, worldIds: [selectedInstalled.id] })}><SlidersHorizontal size={14} />Settings</button>}<button className="secondary-button" onClick={() => window.archipelago?.reveal(selectedInstalled.path)}><FolderOpen size={14} />Reveal</button><button className="secondary-button" onClick={() => void copyDiagnostics(selectedInstalled)}><Clipboard size={14} />Diagnostics</button><button className="secondary-button danger-button" onClick={() => confirmRemove(selectedInstalled)}><Trash2 size={14} />Remove</button></div></div>}
      </aside>}
    </div>

    {confirmation && <div className="dialog-backdrop" onMouseDown={() => setConfirmation(undefined)}><div className="confirm-dialog" onMouseDown={(event) => event.stopPropagation()}><div className={confirmation.danger ? 'confirm-icon danger' : 'confirm-icon'}><ShieldAlert size={20} /></div><h2>{confirmation.title}</h2><p>{confirmation.message}</p><div><button className="secondary-button" onClick={() => setConfirmation(undefined)}>Cancel</button><button className={confirmation.danger ? 'stop-button' : 'primary-button'} disabled={Boolean(busy)} onClick={() => void confirmation.action()}>{busy ? <LoaderCircle className="spin" size={15} /> : confirmation.danger ? <Trash2 size={15} /> : <Download size={15} />}{confirmation.danger ? 'Remove' : 'Continue'}</button></div></div></div>}
  </div>;
}
