const { app, BrowserWindow, clipboard, dialog, ipcMain, net, safeStorage, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { extractZip } = require('./archive.cjs');
const { createApWorldService } = require('./apworlds.cjs');
const { createYamlValidator, yamlFingerprint: contentFingerprint } = require('./yaml-validation.cjs');
const { inventoryLauncherComponents, resolveLauncherClient } = require('./launcher-components.cjs');
const { createApUpdateService } = require('./ap-update.cjs');
const { readHostConfig, writeHostConfig } = require('./host-config.cjs');
const rooms = require('./rooms.cjs');
const { createRoomPortal, localAddress } = require('./room-portal.cjs');
const { createHttpsGateway } = require('./https-gateway.cjs');
const { createGatewayFirewall } = require('./gateway-firewall.cjs');
const { inventoryPopTracker, popTrackerArgs } = require('./poptracker.cjs');
const { actionFromShortcut, launchProfile } = require('./game-launch.cjs');
const { inventoryMinecraftLauncher } = require('./minecraft-launcher.cjs');
const { parseUniversalTrackerOutput } = require('./universal-tracker.cjs');
const { createTrackerSidecar } = require('./tracker-sidecar.cjs');
const { archiveMultidata, checkedSphereSnapshot, completeSphereSnapshot } = require('./multidata-spheres.cjs');
const YAML = require('yaml');

const isDev = process.argv.includes('--dev');
const ROOM_HOST = 'archipelago.gg';
const isSmoke = process.argv.includes('--smoke') || process.env.ARCHIPELAGO_CONTROLLER_SMOKE === '1';
let activeHost = null;
let activeHostMeta = null;
let remoteConsole = null;
let quitting = false;
let mainWindow = null;
let activeGeneratorJobs = 0;
let validationBusy = false;
let activeShare = null;
let activeSphereData = null;
let activeSphereSnapshot = null;
let gatewayStatus = { gateway: 'disabled', certificate: 'unused', firewall: 'unused' };
let pendingRoomInvite = process.argv.find((value) => /^archipelago-controller:\/\/join/i.test(value));
function roomInstallWorldId(raw) {
  try {
    if (!/^archipelago-controller:\/\/install-apworld/i.test(String(raw || ''))) return undefined;
    const worldId = new URL(raw).searchParams.get('worldId');
    return ['tracker', 'slotlock'].includes(worldId) ? worldId : undefined;
  } catch { return undefined; }
}
let pendingRoomInstall = roomInstallWorldId(process.argv.find((value) => /^archipelago-controller:\/\/install-apworld/i.test(value)));
const trackerPackageCache = new Map();
const sphereArtifactCache = new Map();
const activeLogicAnalyses = new Map();
const activeRoomDownloads = new Map();
const roomPortal = createRoomPortal({
  patchArchive: rooms.patchArchive,
  onObserved: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rooms:share-status', { reachability: 'observed' });
  },
  onWake: async ({ roomId }) => {
    if (!activeShare || activeShare.roomId !== roomId) return { status: 'host unavailable' };
    if (!activeShare.portalConfig.allowRemoteWake) return { status: 'disabled' };
    if (activeHost && activeHost.exitCode === null) return { status: activeHostMeta?.roomId === roomId ? 'online' : 'busy' };
    if (!mainWindow || mainWindow.isDestroyed()) return { status: 'host unavailable' };
    mainWindow.webContents.send('rooms:wake-request', { roomId });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (activeHost && activeHost.exitCode === null) return { status: activeHostMeta?.roomId === roomId ? 'online' : 'busy' };
    }
    return { status: 'failed', error: 'Controller did not confirm that the game server started.' };
  },
});
const trackerSidecar = createTrackerSidecar({
  createSocket: (url) => new net.WebSocket(url),
  onUpdate: (snapshot) => {
    if (activeShare?.roomId === snapshot.roomId) {
      roomPortal.updateTracker(snapshot);
      void fs.writeFile(path.join(activeShare.folderPath, 'tracker-snapshot.json'), JSON.stringify(snapshot), 'utf8').catch(() => {});
      if (activeSphereData) {
        activeSphereSnapshot = { ...checkedSphereSnapshot(activeSphereData.value, snapshot), artifactHash: activeSphereData.hash, refreshedAt: new Date().toISOString() };
        roomPortal.updateSpheres(activeSphereSnapshot);
      }
    }
  },
});
const gatewayFirewall = createGatewayFirewall({
  spawn,
  onLog: (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('process:log', `[Firewall] ${line}\n`);
  },
});
const httpsGateway = createHttpsGateway({
  app,
  spawn,
  onStatus: (status) => {
    gatewayStatus = { ...gatewayStatus, ...status };
    if (activeShare) void publishShareStatus({ roomId: activeShare.roomId, ...gatewayStatus });
  },
  onLog: (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('process:log', `[HTTPS] ${line}\n`);
  },
});

const apWorldService = createApWorldService({
  app,
  net,
  shell,
  isBusy: () => activeGeneratorJobs > 0 || validationBusy || Boolean(activeHost && activeHost.exitCode === null),
});
const yamlValidator = createYamlValidator({
  resolveGames: (payload) => apWorldService.resolveGames(payload),
  onBusy: (busy) => { validationBusy = busy; },
});
const apUpdateService = createApUpdateService({ app, net });

app.setAppUserModelId('io.archipelago.controller');
if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient('archipelago-controller', process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient('archipelago-controller');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance', (_event, argv) => {
  const invite = argv.find((value) => /^archipelago-controller:\/\/join/i.test(value));
  if (invite) {
    pendingRoomInvite = invite;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rooms:invite', invite);
  }
  const installLink = argv.find((value) => /^archipelago-controller:\/\/install-apworld/i.test(value));
  if (installLink) {
    const worldId = roomInstallWorldId(installLink);
    if (worldId) {
      pendingRoomInstall = worldId;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rooms:install-apworld', worldId);
    }
  }
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (/^archipelago-controller:\/\/join/i.test(url)) {
    pendingRoomInvite = url;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rooms:invite', url);
  }
  if (/^archipelago-controller:\/\/install-apworld/i.test(url)) {
    const worldId = roomInstallWorldId(url);
    if (worldId) {
      pendingRoomInstall = worldId;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rooms:install-apworld', worldId);
    }
  }
});

const executablePath = (installRoot, name) => installRoot ? path.join(installRoot, name) : '';
const secretFile = () => path.join(app.getPath('userData'), 'secrets.json');

async function readSecrets() {
  try { return JSON.parse(await fs.readFile(secretFile(), 'utf8')); } catch { return {}; }
}

async function encryptValue(value) {
  if (!value) return '';
  if (safeStorage.encryptStringAsync) return (await safeStorage.encryptStringAsync(value)).toString('base64');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
  return safeStorage.encryptString(value).toString('base64');
}

async function decryptValue(encoded) {
  if (!encoded) return '';
  const buffer = Buffer.from(encoded, 'base64');
  if (safeStorage.decryptStringAsync) {
    const result = await safeStorage.decryptStringAsync(buffer);
    return typeof result === 'string' ? result : result.decryptedString ?? result.plainText ?? '';
  }
  return safeStorage.decryptString(buffer);
}

async function getSecret(id) {
  if (!id) return '';
  const secrets = await readSecrets();
  return decryptValue(secrets[id]);
}

async function setSecret(id, value) {
  if (!id || !/^[a-z0-9:_-]{1,120}$/i.test(id)) throw new Error('Invalid secret identifier.');
  const secrets = await readSecrets();
  if (value) secrets[id] = await encryptValue(value);
  else delete secrets[id];
  await fs.mkdir(path.dirname(secretFile()), { recursive: true });
  await fs.writeFile(secretFile(), JSON.stringify(secrets), 'utf8');
  return { ok: true, configured: Boolean(value) };
}

async function removeLegacyRoomAccessSecrets() {
  const secrets = await readSecrets();
  const legacyIds = Object.keys(secrets).filter((id) => id.startsWith('room-share:') || id.startsWith('room-access:'));
  if (!legacyIds.length) return;
  for (const id of legacyIds) delete secrets[id];
  await fs.mkdir(path.dirname(secretFile()), { recursive: true });
  await fs.writeFile(secretFile(), JSON.stringify(secrets), 'utf8');
}

function sendConsole(sender, target, text, level = 'info') {
  if (!sender || sender.isDestroyed() || !text) return;
  sender.send('console:event', { target, level, text: String(text).trimEnd(), timestamp: new Date().toISOString() });
}

function sendHostOutput(sender, chunk, fallbackLevel) {
  for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
    if (activeShare) roomPortal.updatePresence(line);
    if (/connection rejected \(400 Bad Request\)/i.test(line)) {
      sendConsole(sender, 'local', 'Client WebSocket probe rejected; waiting for its automatic retry.', 'info');
    } else if (/\bconnection (open|closed)\b/i.test(line)) {
      sendConsole(sender, 'local', line, 'info');
    } else {
      sendConsole(sender, 'local', line, fallbackLevel);
    }
  }
}

function sendRemoteStatus(sender, state, detail) {
  if (!sender || sender.isDestroyed()) return;
  sender.send('remote:status', { state, detail });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#18201e',
    icon: path.join(__dirname, '..', isDev ? 'build' : 'dist', 'icon.png'),
    titleBarStyle: 'hiddenInset',
    show: !isSmoke,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) window.loadURL('http://127.0.0.1:5173');
  else window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow = window;
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await removeLegacyRoomAccessSecrets().catch(() => {});
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('before-quit', () => {
  quitting = true;
  if (remoteConsole?.reconnectTimer) clearTimeout(remoteConsole.reconnectTimer);
  remoteConsole?.socket?.close();
  if (activeHost && activeHost.exitCode === null) activeHost.kill();
  trackerSidecar.stop();
  void roomPortal.stop();
  void httpsGateway.stop();
});

ipcMain.handle('files:pick-yaml', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Archipelago YAML', extensions: ['yaml', 'yml'] }],
  });
  if (result.canceled) return [];
  return Promise.all(result.filePaths.map(async (filePath) => ({
    path: filePath,
    name: path.basename(filePath),
    content: await fs.readFile(filePath, 'utf8'),
  })));
});

ipcMain.handle('files:read-yaml-directory', async (_event, directoryPath) => {
  if (!directoryPath) return [];
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const yamlFiles = entries.filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name));
  return Promise.all(yamlFiles.map(async (entry) => {
    const filePath = path.join(directoryPath, entry.name);
    return { path: filePath, name: entry.name, content: await fs.readFile(filePath, 'utf8') };
  }));
});

ipcMain.handle('files:pick-directory', async (_event, title) => {
  const result = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('files:pick-executable', async (_event, title) => {
  const result = await dialog.showOpenDialog({
    title,
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd'] }] : [],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('files:pick-launch-file', async (_event, title) => {
  const result = await dialog.showOpenDialog({ title: String(title ?? 'Choose a launch file'), properties: ['openFile'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('files:pick-launch-shortcut', async () => {
  const result = await dialog.showOpenDialog({ title: 'Import a Windows or Steam shortcut', properties: ['openFile'], filters: [{ name: 'Shortcuts', extensions: ['lnk', 'url'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const shortcutPath = result.filePaths[0];
  if (/\.url$/i.test(shortcutPath)) {
    const contents = await fs.readFile(shortcutPath, 'utf8');
    const target = contents.match(/^URL=(.+)$/mi)?.[1]?.trim();
    if (!target) throw new Error('That Internet shortcut has no URL.');
    return { action: actionFromShortcut({ target }), name: path.basename(shortcutPath, path.extname(shortcutPath)) };
  }
  const shortcut = shell.readShortcutLink(shortcutPath);
  return { action: actionFromShortcut(shortcut), name: shortcut.description || path.basename(shortcutPath, path.extname(shortcutPath)) };
});

ipcMain.handle('files:pick-steam-source-mod', async () => {
  const defaultPath = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'sourcemods');
  const result = await dialog.showOpenDialog({ title: 'Choose a Steam Source mod', defaultPath, properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const folder = path.resolve(result.filePaths[0]);
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const gameInfoName = entries.find((entry) => entry.isFile() && entry.name.toLocaleLowerCase() === 'gameinfo.txt')?.name;
  if (!gameInfoName) throw new Error('That folder has no GameInfo.txt and is not a Source mod.');
  const contents = await fs.readFile(path.join(folder, gameInfoName), 'utf8');
  const appId = contents.match(/\bSteamAppId\s+"?(\d+)"?/i)?.[1];
  if (!appId) throw new Error('GameInfo.txt does not declare a SteamAppId.');
  const title = contents.match(/^\s*(?:title|game)\s+"([^"]+)"/mi)?.[1] ?? path.basename(folder);
  return { path: folder, appId, title };
});

ipcMain.handle('files:pick-apworld', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import APWorld',
    properties: ['openFile'],
    filters: [{ name: 'Archipelago World', extensions: ['apworld'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('files:export-yaml', async (_event, payload) => {
  const result = await dialog.showSaveDialog({
    title: 'Export player YAML',
    defaultPath: payload.fileName,
    filters: [{ name: 'Archipelago YAML', extensions: ['yaml'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  await fs.writeFile(result.filePath, payload.content, 'utf8');
  return { ok: true, path: result.filePath };
});

ipcMain.handle('files:export-yaml-pack', async (_event, payload) => {
  const result = await dialog.showOpenDialog({ title: 'Choose YAML export folder', properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled) return { ok: false, canceled: true, paths: [] };
  const folder = result.filePaths[0];
  const paths = [];
  for (const file of payload.files) {
    const parsed = path.parse(file.name.replace(/[^a-z0-9_.-]+/gi, ''));
    let target = path.join(folder, `${parsed.name}${parsed.ext || '.yaml'}`);
    let suffix = 2;
    while (await fs.access(target).then(() => true).catch(() => false)) {
      target = path.join(folder, `${parsed.name}-${suffix++}${parsed.ext || '.yaml'}`);
    }
    await fs.writeFile(target, file.content, 'utf8');
    paths.push(target);
  }
  return { ok: true, paths };
});

ipcMain.handle('files:exists', async (_event, filePath) => {
  if (!filePath) return false;
  try { await fs.access(filePath); return true; } catch { return false; }
});

ipcMain.handle('files:reveal', async (_event, targetPath) => {
  try {
    const stats = await fs.stat(targetPath);
    if (stats.isFile()) { shell.showItemInFolder(targetPath); return ''; }
  } catch { /* openPath will return the platform error */ }
  return shell.openPath(targetPath);
});
ipcMain.handle('system:open-external', async (_event, rawUrl) => {
  const url = new URL(String(rawUrl));
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web links can be opened.');
  return shell.openExternal(url.toString());
});

ipcMain.handle('secrets:set', async (_event, payload) => setSecret(payload.id, String(payload.value ?? '')));
ipcMain.handle('secrets:remove', async (_event, id) => setSecret(id, ''));

ipcMain.handle('tools:inventory', async (_event, installRoot) => {
  let entries = [];
  try { entries = await fs.readdir(installRoot, { withFileTypes: true }); } catch { return { programs: [], worlds: [], components: [] }; }
  const programs = entries
    .filter((entry) => entry.isFile() && /^Archipelago.*\.exe$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(installRoot, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  let worlds = [];
  try {
    const worldEntries = await fs.readdir(path.join(installRoot, 'custom_worlds'), { withFileTypes: true });
    worlds = worldEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.apworld'))
      .map((entry) => ({ name: entry.name.replace(/\.apworld$/i, ''), path: path.join(installRoot, 'custom_worlds', entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* Custom worlds are optional. */ }
  const components = await inventoryLauncherComponents(installRoot);
  return { programs, worlds, components };
});
ipcMain.handle('archipelago:update-status', async (_event, payload) => apUpdateService.check(payload));

function ipcResult(action) {
  return async (_event, payload) => {
    try { return await action(payload); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  };
}

ipcMain.handle('host-config:read', ipcResult((installRoot) => readHostConfig(installRoot)));
ipcMain.handle('host-config:write', ipcResult((payload) => writeHostConfig(payload)));

ipcMain.handle('apworlds:inventory', async (_event, installRoot) => apWorldService.inventory(installRoot));
ipcMain.handle('apworlds:catalog', async (_event, options) => apWorldService.getCatalog(options));
ipcMain.handle('apworlds:refresh', async () => apWorldService.refresh());
ipcMain.handle('apworlds:install', ipcResult((payload) => apWorldService.install(payload)));
ipcMain.handle('apworlds:import', ipcResult((payload) => apWorldService.importLocal(payload)));
ipcMain.handle('apworlds:remove', ipcResult((payload) => apWorldService.remove(payload)));
ipcMain.handle('yaml:resolve-games', async (_event, payload) => apWorldService.resolveGames(payload));
ipcMain.handle('yaml:validate', async (event, payload) => {
  try { return await yamlValidator.validate(payload, event.sender); }
  catch (error) { return { ok: false, results: [], error: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('yaml:cancel-validation', () => yamlValidator.cancel());

ipcMain.handle('tools:launch', async (_event, executablePath) => {
  try {
    const child = spawn(executablePath, [], { cwd: path.dirname(executablePath), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

async function launchArchipelagoLauncher(installRoot, argument) {
  const root = path.resolve(String(installRoot ?? ''));
  const launcher = path.join(root, 'ArchipelagoLauncher.exe');
  await fs.access(launcher);
  // Frozen Archipelago components resolve Kivy and other bundled resources from
  // the installation directory, even when their input file lives elsewhere.
  const child = spawn(launcher, argument ? [argument] : [], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: { ...process.env, KIVY_DATA_DIR: path.join(root, 'data') },
  });
  child.unref();
  return { ok: true };
}

ipcMain.handle('tools:launch-component', ipcResult(async (payload) => {
  const displayName = String(payload?.displayName ?? '').trim();
  if (!displayName || displayName.length > 100) throw new Error('Invalid APWorld component name.');
  const components = await inventoryLauncherComponents(payload?.installRoot);
  if (!components.some((component) => component.displayName === displayName)) throw new Error('That APWorld tool is no longer installed. Refresh Tools and try again.');
  return launchArchipelagoLauncher(payload.installRoot, displayName);
}));

ipcMain.handle('rooms:inspect', ipcResult(async (payload) => {
  try {
    const status = await rooms.refreshRoom(net, payload?.url, Boolean(payload?.wake));
    return { ...status, provider: { type: 'official', roomUrl: status.url } };
  } catch (officialError) {
    let invitation;
    try { invitation = rooms.parseControllerInvite(payload?.url); }
    catch { throw officialError; }
    const status = await rooms.refreshControllerRoom(net, invitation.url);
    return { ...status, provider: { type: 'controller', roomUrl: invitation.url, apiVersion: status.capabilities?.apiVersion ?? 1, capabilities: status.capabilities } };
  }
}));
ipcMain.handle('rooms:take-invite', () => {
  const invite = pendingRoomInvite;
  pendingRoomInvite = undefined;
  return invite ?? null;
});
ipcMain.handle('rooms:take-install-apworld', () => {
  const worldId = pendingRoomInstall;
  pendingRoomInstall = undefined;
  return worldId ?? null;
});
ipcMain.handle('rooms:wake', ipcResult(async (payload) => {
  const room = rooms.parseControllerInvite(payload?.provider?.roomUrl || payload?.roomUrl);
  const statusResponse = await net.fetch(`${room.origin}/api/controller/v2/room/${room.id}/status`);
  if (!statusResponse.ok) throw new Error(`Wake status returned HTTP ${statusResponse.status}.`);
  const status = await statusResponse.json();
  const response = await net.fetch(`${room.origin}/api/controller/v2/room/${room.id}/actions/wake`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: room.origin, 'x-controller-wake': String(status.wakeNonce || '') }, body: '{}',
  });
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok && result.status !== 'disabled') throw new Error(result.error || result.status || `Wake failed with HTTP ${response.status}.`);
  return result;
}));
ipcMain.handle('rooms:ensure', ipcResult(async (payload) => ({ folderPath: await rooms.ensureRoom(payload?.roomsRoot, payload?.label, payload?.roomId) })));
ipcMain.handle('rooms:adopt-local', ipcResult(async (payload) => rooms.adoptLocalRun(payload)));
ipcMain.handle('rooms:list-files', ipcResult(async (payload) => {
  const folder = rooms.inside(payload?.roomsRoot, payload?.folderPath);
  const downloads = await rooms.listFiles(path.join(folder, 'downloads', rooms.safeName(payload?.slotName, `slot-${payload?.slot}`)), 'downloaded');
  const slotFolder = path.join(folder, 'play', rooms.safeName(payload?.slotName, `slot-${payload?.slot}`));
  const play = await rooms.listFiles(slotFolder, 'generated');
  return { downloads, play };
}));
ipcMain.handle('rooms:download-slot', ipcResult(async (payload) => {
  if (payload?.provider?.type === 'controller') {
    const jobId = String(payload?.jobId || randomUUID());
    if (!/^[A-Za-z0-9:_-]{6,160}$/.test(jobId)) throw new Error('Invalid room download job.');
    const controller = new AbortController();
    activeRoomDownloads.set(jobId, controller);
    try {
      return await rooms.downloadControllerSlot(net, payload, { signal: controller.signal, onProgress: (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rooms:download-progress', { jobId, ...progress });
      } });
    } finally { activeRoomDownloads.delete(jobId); }
  }
  if (payload?.provider?.type === 'local') throw new Error('Local room files are already available in this workspace.');
  return rooms.downloadSlot(net, payload);
}));
ipcMain.handle('rooms:cancel-download', ipcResult(async (jobId) => {
  const controller = activeRoomDownloads.get(String(jobId));
  if (!controller) return { cancelled: false };
  controller.abort();
  return { cancelled: true };
}));
ipcMain.handle('rooms:import-file', ipcResult(async (payload) => {
  const result = await dialog.showOpenDialog({ title: `Add a file for ${String(payload?.slotName ?? 'room slot')}`, properties: ['openFile'] });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { files: await rooms.importFile(result.filePaths[0], payload) };
}));

function shareBaseUrl(config, gateway, externalIp) {
  if (gateway.mode === 'managed') return `https://${gateway.hostname}`;
  if (gateway.mode === 'external') {
    const url = new URL(String(gateway.publicBaseUrl));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Public portal URL must be an HTTP or HTTPS origin without a path.');
    if (url.protocol !== 'https:') throw new Error('The external public portal URL must use HTTPS.');
    return url.toString().replace(/\/$/, '');
  }
  const host = String(config.advertisedHost || externalIp || '').trim();
  if (!host) throw new Error('Enter a public hostname or enable automatic port mapping so Controller can discover one.');
  return `http://${host}:${Number(config.portalPort)}`;
}

function shareInvites(baseUrl, roomId) {
  const browserUrl = `${baseUrl}/room/${roomId}`;
  return { browserUrl, controllerUrl: `archipelago-controller://join?url=${encodeURIComponent(browserUrl)}` };
}

async function publishShareStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rooms:share-status', status);
}

ipcMain.handle('rooms:start-sharing', ipcResult(async (payload) => {
  if (activeShare && activeShare.roomId !== payload?.roomId) throw new Error('Stop sharing the current room before sharing another one.');
  const roomId = String(payload?.roomId ?? '');
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(roomId)) throw new Error('Invalid local room identifier.');
  const portalPort = Number(payload?.hosted?.portalPort);
  const gamePort = Number(payload?.hosted?.gamePort);
  const gateway = payload?.gateway ?? { mode: 'local' };
  if (![portalPort, gamePort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535) || portalPort === gamePort) throw new Error('Choose distinct valid game and portal ports.');
  if (!['managed', 'external', 'direct'].includes(gateway.mode)) throw new Error('Configure public room sharing in Settings before sharing this room.');
  if (gateway.mode === 'direct' && !payload?.hosted?.insecureHttpAccepted) throw new Error('Acknowledge direct HTTP sharing before starting the portal.');
  if (gateway.mode === 'external' && !String(gateway.publicBaseUrl ?? '').startsWith('https://')) throw new Error('Configure an HTTPS public portal URL in Settings.');
  const slots = await rooms.sharedSlotInventory(payload);
  if (!slots.length) throw new Error('This room has no player slots to share.');
  const roomComponents = await inventoryLauncherComponents(payload?.installRoot).catch(() => []);
  const hostApiKey = payload?.hostApi?.secretRef ? await getSecret(payload.hostApi.secretRef) : '';
  activeSphereData = null;
  activeSphereSnapshot = null;
  let sphereUnavailable = { available: false, reason: 'absent', checks: [], refreshedAt: new Date().toISOString() };
  if (payload?.hosted?.artifactPath) {
    try {
      const bytes = await fs.readFile(path.resolve(payload.hosted.artifactPath));
      const cacheKey = createHash('sha256').update(bytes).digest('hex');
      activeSphereData = sphereArtifactCache.get(cacheKey) ?? archiveMultidata(bytes);
      sphereArtifactCache.set(cacheKey, activeSphereData);
      while (sphereArtifactCache.size > 8) sphereArtifactCache.delete(sphereArtifactCache.keys().next().value);
    }
    catch (error) { sphereUnavailable = { available: false, reason: /version|protocol|opcode|global/i.test(error.message) ? 'incompatible' : 'malformed', error: error.message, checks: [], refreshedAt: new Date().toISOString() }; }
  }
  const portalConfig = {
    roomId, label: String(payload.label || 'Archipelago Room'), generationId: String(payload.hosted.historyRunId || ''),
    createdAt: String(payload.createdAt || ''), passwordRequired: Boolean(payload.passwordRequired),
    portalPort, automaticPortMapping: Boolean(payload.hosted.automaticPortMapping), slots,
    bindHost: gateway.mode === 'managed' ? '127.0.0.1' : '0.0.0.0',
    mappingPorts: gateway.mode === 'managed' ? [80, 443, 38281, gamePort] : gateway.mode === 'external' ? [gamePort] : [portalPort, gamePort],
    serverRunning: Boolean(activeHost && activeHost.exitCode === null && activeHostMeta?.roomId === roomId),
    allowRemoteWake: Boolean(payload.hosted.allowRemoteWake),
    wakeNonce: randomBytes(16).toString('base64url'),
    tools: {
      trackerInstalled: roomComponents.some((component) => component.displayName === 'Universal Tracker'),
      slotlockInstalled: roomComponents.some((component) => /slotlock/i.test(component.displayName)),
      hasSlotLock: slots.some((slot) => /slotlock/i.test(slot.game)),
    },
    hostApiKey,
    hostApiRemote: Boolean(payload?.hostApi?.remoteEnabled),
    allowSpoilerApi: Boolean(payload?.hostApi?.allowSpoilers),
    raceMode: Boolean(activeSphereData?.value?.race_mode),
    sourceMetadata: activeSphereData ? {
      artifactSha256: activeSphereData.hash,
      seedName: String(activeSphereData.value?.seed_name || ''),
      multidataVersion: Number(activeSphereData.value?.version || 3),
      slotCount: Object.keys(activeSphereData.value?.slot_info || {}).length,
      games: [...new Set(Object.values(activeSphereData.value?.slot_info || {}).map((entry) => String(entry?.args?.[1] || 'Unknown')))],
      staticSphereCount: Array.isArray(activeSphereData.value?.spheres) ? activeSphereData.value.spheres.length : 0,
      raceMode: Boolean(activeSphereData.value?.race_mode),
    } : undefined,
    spoilerExport: activeSphereData && payload?.hostApi?.allowSpoilers && !activeSphereData.value?.race_mode
      ? completeSphereSnapshot(activeSphereData.value) : undefined,
    publicOrigin: gateway.mode === 'managed' ? `https://${gateway.hostname}`
      : gateway.mode === 'external' ? new URL(gateway.publicBaseUrl).origin
        : `http://${String(payload.hosted.advertisedHost || '')}:${portalPort}`,
    endpoint: { host: String(payload.hosted.advertisedHost || ''), port: gateway.mode === 'managed' ? 443 : gamePort, secure: gateway.mode === 'managed' },
  };
  await publishShareStatus({ roomId, state: 'starting', serverRunning: portalConfig.serverRunning, portalRunning: false, mapping: portalConfig.automaticPortMapping ? 'starting' : 'disabled', reachability: 'unknown' });
  if (gateway.mode === 'managed') {
    gatewayStatus = { gateway: 'starting', certificate: 'unused', firewall: 'checking' };
    await publishShareStatus({ roomId, portalRunning: false, ...gatewayStatus });
    try {
      const firewallInspection = await gatewayFirewall.inspect();
      if (firewallInspection.state === 'required') {
        const options = {
          type: 'warning',
          title: 'Allow managed room sharing',
          message: 'Controller needs durable Windows Firewall rules before it can share this room.',
          detail: `This opens inbound TCP ports ${firewallInspection.missing.map((rule) => rule.port).join(', ')} on Private and Public network profiles. The rules are limited to Archipelago Controller's managed gateway ports and remain available across portable-app restarts. Windows will ask for administrator approval next.`,
          buttons: ['Cancel', 'Allow gateway ports'],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        };
        const confirmation = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options);
        if (confirmation.response !== 1) throw new Error('Room sharing was cancelled before changing Windows Firewall.');
      }
      await gatewayFirewall.ensure();
      gatewayStatus = { ...gatewayStatus, firewall: 'ready' };
      await publishShareStatus({ roomId, portalRunning: false, ...gatewayStatus });
    } catch (error) {
      gatewayStatus = { gateway: 'error', certificate: 'unused', firewall: 'error', gatewayError: error instanceof Error ? error.message : String(error) };
      await publishShareStatus({ roomId, portalRunning: false, ...gatewayStatus });
      throw error;
    }
  }
  let managedGatewayStarted = false;
  const startManagedGateway = gateway.mode === 'managed' ? async () => {
    gatewayStatus = { ...gatewayStatus, gateway: 'starting', certificate: 'obtaining', gatewayError: undefined };
    await publishShareStatus({ roomId, portalRunning: true, ...gatewayStatus });
    await httpsGateway.start({ hostname: gateway.hostname, email: gateway.email, upstreamPort: portalPort, gamePort, compatibilityBindHost: localAddress(), compatibilityPort: 38281 });
    managedGatewayStarted = true;
  } : undefined;
  let result;
  let baseUrl;
  try {
    gatewayStatus = gateway.mode === 'managed' ? { ...gatewayStatus, gateway: 'starting', certificate: 'obtaining' } : { gateway: gateway.mode === 'external' ? 'online' : 'disabled', certificate: gateway.mode === 'external' ? 'ready' : 'unused', firewall: 'unused' };
    result = await roomPortal.start(portalConfig, startManagedGateway);
    activeSphereSnapshot = activeSphereData && trackerSidecar.roomId === roomId
      ? { ...checkedSphereSnapshot(activeSphereData.value, trackerSidecar.snapshot()), artifactHash: activeSphereData.hash, refreshedAt: new Date().toISOString() }
      : sphereUnavailable;
    roomPortal.updateSpheres(activeSphereSnapshot);
    if (trackerSidecar.roomId === roomId) roomPortal.updateTracker(trackerSidecar.snapshot());
    if (gateway.mode === 'managed' && !managedGatewayStarted) throw new Error('Managed HTTPS did not start.');
    baseUrl = shareBaseUrl(payload.hosted, gateway, result.externalIp);
    portalConfig.endpoint.host ||= String(payload.hosted.advertisedHost || gateway.hostname || result.externalIp || new URL(baseUrl).hostname || '');
    if (!portalConfig.endpoint.host) throw new Error('Controller could not determine the public game-server hostname.');
  } catch (error) {
    await httpsGateway.stop();
    await roomPortal.stop();
    throw error;
  }
  const shareFolder = rooms.inside(payload.roomsRoot, payload.folderPath);
  activeShare = { roomId, baseUrl, portalConfig, result, folderPath: shareFolder };
  try {
    const cachedTracker = JSON.parse(await fs.readFile(path.join(shareFolder, 'tracker-snapshot.json'), 'utf8'));
    if (!trackerSidecar.running || trackerSidecar.roomId !== roomId) roomPortal.updateTracker({ ...cachedTracker, stale: true });
  } catch { /* Tracker persistence is optional until the first live update. */ }
  try {
    const cachedLogic = JSON.parse(await fs.readFile(path.join(shareFolder, 'logic-analyses.json'), 'utf8'));
    for (const [slot, analysis] of Object.entries(cachedLogic)) roomPortal.updateLogic(Number(slot), { ...analysis, stale: true });
  } catch { /* Logic persistence is optional. */ }
  const status = { roomId, state: 'sharing', serverRunning: portalConfig.serverRunning, portalRunning: true, mapping: result.mapping, reachability: 'unknown', publicUrl: `${baseUrl}/room/${roomId}`, secureGameEndpoint: gateway.mode === 'managed' ? `${portalConfig.endpoint.host}:443` : undefined, compatibilityGameEndpoint: gateway.mode === 'managed' ? `${portalConfig.endpoint.host}:38281` : undefined, error: result.mappingError, ...gatewayStatus };
  await publishShareStatus(status);
  return { ...status, advertisedHost: portalConfig.endpoint.host, mappingMethod: result.mappingMethod };
}));

ipcMain.handle('rooms:stop-sharing', ipcResult(async (payload) => {
  if (activeShare && payload?.roomId && activeShare.roomId !== payload.roomId) throw new Error('That room is not currently being shared.');
  const roomId = activeShare?.roomId ?? payload?.roomId;
  await httpsGateway.stop();
  await roomPortal.stop();
  activeSphereData = null;
  activeSphereSnapshot = null;
  gatewayStatus = { gateway: 'disabled', certificate: 'unused', firewall: 'unused' };
  activeShare = null;
  const status = { roomId, state: 'offline', serverRunning: Boolean(activeHost && activeHost.exitCode === null && activeHostMeta?.roomId === roomId), portalRunning: false, mapping: 'disabled', reachability: 'unknown', ...gatewayStatus };
  await publishShareStatus(status);
  return status;
}));

ipcMain.handle('rooms:copy-invite', ipcResult(async (payload) => {
  if (!activeShare || activeShare.roomId !== payload?.roomId) throw new Error('Start sharing this room first.');
  const invites = shareInvites(activeShare.baseUrl, activeShare.roomId);
  clipboard.writeText(payload?.kind === 'controller' ? invites.controllerUrl : invites.browserUrl);
  return { copied: true };
}));

ipcMain.handle('rooms:open-share', ipcResult(async (payload) => {
  if (!activeShare || activeShare.roomId !== payload?.roomId) throw new Error('Start sharing this room first.');
  await shell.openExternal(shareInvites(activeShare.baseUrl, activeShare.roomId).browserUrl);
  return { opened: true };
}));

ipcMain.handle('rooms:share-status', () => activeShare ? {
  roomId: activeShare.roomId, state: 'sharing', serverRunning: activeShare.portalConfig.serverRunning,
  portalRunning: roomPortal.running, mapping: activeShare.result.mapping, reachability: 'unknown', publicUrl: `${activeShare.baseUrl}/room/${activeShare.roomId}`, secureGameEndpoint: activeShare.portalConfig.endpoint.secure ? `${activeShare.portalConfig.endpoint.host}:${activeShare.portalConfig.endpoint.port}` : undefined, compatibilityGameEndpoint: activeShare.portalConfig.endpoint.secure ? `${activeShare.portalConfig.endpoint.host}:38281` : undefined, ...gatewayStatus,
} : { state: 'offline', serverRunning: Boolean(activeHost && activeHost.exitCode === null), portalRunning: false, mapping: 'disabled', reachability: 'unknown' });

async function currentRoomStatus(payload) {
  const provider = payload?.provider;
  let status;
  if (provider?.type === 'local') {
    if (!activeHostMeta || activeHostMeta.roomId !== payload?.roomId || !activeHost || activeHost.exitCode !== null) throw new Error('Start this local room server first.');
    status = { lastPort: activeHostMeta.port, endpoint: { host: 'localhost', port: activeHostMeta.port, secure: false }, refreshedAt: new Date().toISOString(), stale: false };
  } else if (provider?.type === 'controller') {
    status = await rooms.refreshControllerRoom(net, provider.roomUrl || payload?.roomUrl);
  } else {
    status = await rooms.refreshRoom(net, provider?.roomUrl || payload?.roomUrl, true);
  }
  if (!status.lastPort || !status.endpoint && provider?.type === 'controller') throw new Error('The room has no active server endpoint.');
  return status;
}

function endpointFor(status) {
  return status.endpoint ?? { host: ROOM_HOST, port: status.lastPort, secure: true };
}

ipcMain.handle('rooms:launch-file', ipcResult(async (payload) => {
  const status = await currentRoomStatus(payload);
  const endpoint = endpointFor(status);
  const prepared = await rooms.prepareFile(payload, `${endpoint.host}:${endpoint.port}`);
  const components = await inventoryLauncherComponents(payload?.installRoot);
  const capability = resolveLauncherClient(components, payload?.game);
  await launchArchipelagoLauncher(payload?.installRoot, prepared.file.path);
  if (payload?.autoConnect && capability.supportsUri) {
    const password = await getSecret(payload?.passwordRef);
    const uri = rooms.connectionUri(payload?.slotName, password, endpoint.host, endpoint.port, capability.gameName ?? payload?.game);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await launchArchipelagoLauncher(payload?.installRoot, uri);
  }
  return { ...prepared, status, capability };
}));

ipcMain.handle('rooms:launch-client', ipcResult(async (payload) => {
  const status = await currentRoomStatus(payload);
  const endpoint = endpointFor(status);
  const components = await inventoryLauncherComponents(payload?.installRoot);
  const capability = resolveLauncherClient(components, payload?.game);
  const password = await getSecret(payload?.passwordRef);
  const uri = rooms.connectionUri(payload?.slotName, password, endpoint.host, endpoint.port, capability.gameName ?? payload?.game);
  await launchArchipelagoLauncher(payload?.installRoot, uri);
  return { status, capability };
}));

ipcMain.handle('rooms:open-tracker', ipcResult(async (payload) => {
  if (payload?.provider?.type === 'controller') {
    const invitation = rooms.parseControllerInvite(payload?.provider?.roomUrl || payload?.roomUrl);
    const url = `${invitation.url}${payload?.slot ? `#slot-${Number(payload.slot)}` : '#progress'}`;
    await shell.openExternal(url);
    return { url };
  }
  if (payload?.provider?.type === 'local') {
    if (!activeShare || activeShare.roomId !== payload?.roomId) throw new Error('Share this room to open its browser tracker.');
    const url = `${activeShare.baseUrl}/room/${activeShare.roomId}#progress`;
    await shell.openExternal(url);
    return { url };
  }
  const url = rooms.trackerUrl(payload?.roomUrl, payload?.trackerId, payload?.slot);
  await shell.openExternal(url);
  return { url };
}));

ipcMain.handle('rooms:open-sphere-tracker', ipcResult(async (payload) => {
  if (payload?.provider?.type === 'controller') {
    const invitation = rooms.parseControllerInvite(payload?.provider?.roomUrl || payload?.roomUrl);
    const url = `${invitation.url}#spheres`;
    await shell.openExternal(url);
    return { url };
  }
  if (payload?.provider?.type === 'local') {
    if (!activeShare || activeShare.roomId !== payload?.roomId) throw new Error('Share this room to open its sphere tracker.');
    const url = `${activeShare.baseUrl}/room/${activeShare.roomId}#spheres`;
    await shell.openExternal(url);
    return { url };
  }
  if (payload?.provider?.type !== 'official' && payload?.provider) throw new Error('This room does not currently provide a sphere tracker.');
  const url = rooms.sphereTrackerUrl(payload?.roomUrl, payload?.trackerId);
  await shell.openExternal(url);
  return { url };
}));

async function trackerJson(url) {
  const response = await net.fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Archipelago tracker returned HTTP ${response.status}.`);
  return response.json();
}

async function createTrackerWorkspace(payload) {
  const slotName = String(payload?.slotName ?? '').trim();
  const game = String(payload?.game ?? '').trim();
  if (!slotName || slotName.length > 64 || !game || game.length > 120) throw new Error('A valid room slot and game are required for Universal Tracker.');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'archipelago-controller-ut-'));
  try {
    const playerFolder = path.join(workspace, 'Players');
    await fs.mkdir(playerFolder, { recursive: true });
    let document = { name: slotName, game, [game]: {} };
    const yamlContent = String(payload?.yamlContent ?? '');
    if (yamlContent.length > 2 * 1024 * 1024) throw new Error('The selected tracker YAML is too large.');
    if (yamlContent.trim()) {
      const parsed = YAML.parse(yamlContent);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The selected tracker YAML is invalid.');
      document = { ...parsed, name: slotName, game };
    }
    await fs.writeFile(path.join(playerFolder, 'ControllerTracker.yaml'), YAML.stringify(document), 'utf8');
    await fs.writeFile(path.join(workspace, 'host.yaml'), YAML.stringify({ universal_tracker: { player_files_path: playerFolder, display_glitched_logic: true } }), 'utf8');
    return { workspace, templateUsed: Boolean(yamlContent.trim()) };
  } catch (error) {
    await fs.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

async function roomLogicEnvironment(installRoot, game) {
  const [worldInventory, components] = await Promise.all([
    apWorldService.inventory(installRoot).catch(() => ({ installed: [], apVersion: '' })),
    inventoryLauncherComponents(installRoot),
  ]);
  const normalizedGame = String(game || '').trim().toLocaleLowerCase();
  const matchedWorld = worldInventory.installed?.find((world) => String(world.game).trim().toLocaleLowerCase() === normalizedGame);
  const trackerWorld = worldInventory.installed?.find((world) => String(world.id).trim().toLocaleLowerCase() === 'tracker');
  const trackerComponent = components.find((component) => component.displayName === 'Universal Tracker');
  const world = matchedWorld ? `${matchedWorld.id}:${matchedWorld.version || ''}:${matchedWorld.sha256 || ''}` : '';
  const tracker = trackerWorld ? `${trackerWorld.id}:${trackerWorld.version || ''}:${trackerWorld.sha256 || ''}` : `${trackerComponent?.sourceWorld || 'missing'}:${trackerComponent?.origin || ''}`;
  return {
    fingerprint: createHash('sha256').update(JSON.stringify({ apVersion: worldInventory.apVersion || '', world, tracker })).digest('hex'),
    apVersion: worldInventory.apVersion || '', world, tracker, components,
  };
}

ipcMain.handle('rooms:logic-environment', ipcResult(async (payload) => {
  const environment = await roomLogicEnvironment(payload?.installRoot, payload?.game);
  return { fingerprint: environment.fingerprint, apVersion: environment.apVersion, world: environment.world, tracker: environment.tracker };
}));

ipcMain.handle('rooms:tracker-dashboard', ipcResult(async (payload) => {
  if (payload?.provider?.type === 'local') {
    if (!trackerSidecar.running || trackerSidecar.roomId !== payload?.roomId) throw new Error('Start this room server to enable its live tracker.');
    return trackerSidecar.snapshot();
  }
  if (payload?.provider?.type === 'controller') {
    const status = await rooms.refreshControllerRoom(net, payload?.provider?.roomUrl || payload?.roomUrl);
    if (!status.snapshot?.enriched?.dashboard) throw new Error('This Controller host only supports the limited 0.1 room API.');
    return status.snapshot.enriched.dashboard;
  }
  if (payload?.provider?.type !== 'official' && payload?.provider) throw new Error('Live tracker data is not enabled for this room provider yet.');
  const room = rooms.parseRoomUrl(payload?.roomUrl);
  const trackerId = String(payload?.trackerId ?? '');
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(trackerId)) throw new Error('This room has no tracker data yet.');
  const [dynamic, fixed] = await Promise.all([
    trackerJson(`${room.origin}/api/tracker/${trackerId}`),
    trackerJson(`${room.origin}/api/static_tracker/${trackerId}`),
  ]);
  const packages = {};
  await Promise.all(Object.entries(fixed?.datapackage ?? {}).map(async ([game, descriptor]) => {
    const checksum = String(descriptor?.checksum ?? '');
    if (!/^[a-f0-9]{32,64}$/i.test(checksum)) return;
    if (!trackerPackageCache.has(checksum)) trackerPackageCache.set(checksum, trackerJson(`${room.origin}/api/datapackage/${checksum}`));
    try { packages[game] = await trackerPackageCache.get(checksum); }
    catch (error) { trackerPackageCache.delete(checksum); throw error; }
  }));
  return rooms.normalizeTrackerDashboard(dynamic, fixed, payload?.slots, packages);
}));
ipcMain.handle('rooms:spheres', ipcResult(async (payload) => {
  if (payload?.provider?.type === 'local') {
    if (activeShare?.roomId !== payload?.roomId || !activeSphereSnapshot) return { refreshedAt: new Date().toISOString(), available: false, reason: 'not-running', checks: [] };
    return activeSphereSnapshot;
  }
  if (payload?.provider?.type === 'controller') {
    const status = await rooms.refreshControllerRoom(net, payload?.provider?.roomUrl || payload?.roomUrl);
    return status.snapshot?.enriched?.spheres ?? { refreshedAt: status.refreshedAt, available: false, reason: 'incompatible', checks: [] };
  }
  return { refreshedAt: new Date().toISOString(), available: false, reason: 'incompatible', checks: [] };
}));

ipcMain.handle('rooms:launch-universal-tracker', ipcResult(async (payload) => {
  const status = await currentRoomStatus(payload);
  const endpoint = endpointFor(status);
  const components = await inventoryLauncherComponents(payload?.installRoot);
  if (!components.some((component) => component.displayName === 'Universal Tracker')) throw new Error('Universal Tracker is not installed. Add tracker.apworld in APWorlds first.');
  const password = await getSecret(payload?.passwordRef);
  const uri = rooms.connectionUri(payload?.slotName, password, endpoint.host, endpoint.port, payload?.game);
  const root = path.resolve(String(payload?.installRoot ?? ''));
  const launcher = path.join(root, 'ArchipelagoLauncher.exe');
  await fs.access(launcher);
  const { workspace, templateUsed } = await createTrackerWorkspace(payload);
  const child = spawn(launcher, ['Universal Tracker', '--', uri], { cwd: workspace, detached: true, stdio: 'ignore', windowsHide: false });
  child.once('close', () => setTimeout(() => void fs.rm(workspace, { recursive: true, force: true }), 1000));
  child.once('error', () => void fs.rm(workspace, { recursive: true, force: true }));
  child.unref();
  return { status, templateUsed };
}));

ipcMain.handle('rooms:analyze-universal-tracker', ipcResult(async (payload) => {
  const status = await currentRoomStatus(payload);
  const endpoint = endpointFor(status);
  const components = await inventoryLauncherComponents(payload?.installRoot);
  if (!components.some((component) => component.displayName === 'Universal Tracker')) throw new Error('Universal Tracker is not installed. Add tracker.apworld in APWorlds first.');
  const password = await getSecret(payload?.passwordRef);
  const uri = rooms.connectionUri(payload?.slotName, password, endpoint.host, endpoint.port, payload?.game);
  const root = path.resolve(String(payload?.installRoot ?? ''));
  const launcher = path.join(root, 'ArchipelagoLauncherDebug.exe');
  await fs.access(launcher);
  const { workspace, templateUsed } = await createTrackerWorkspace(payload);
  activeGeneratorJobs += 1;
  try {
    const analysisKey = `${String(payload?.roomId)}:${String(payload?.slotName)}`;
    activeLogicAnalyses.get(analysisKey)?.kill();
    const output = await new Promise((resolve, reject) => {
      const child = spawn(launcher, ['Universal Tracker', '--', '--nogui', '--count', '--list', uri], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activeLogicAnalyses.set(analysisKey, child);
      let text = '';
      const append = (chunk) => { if (text.length < 4 * 1024 * 1024) text += chunk.toString(); };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => { child.kill(); reject(new Error('Universal Tracker analysis timed out after 180 seconds.')); }, 180_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); activeLogicAnalyses.delete(analysisKey); if (signal) reject(new Error('Universal Tracker analysis was cancelled.')); else resolve(text); });
    });
    const sanitized = password ? String(output).split(password).join('[redacted]') : String(output);
    const environment = await roomLogicEnvironment(payload?.installRoot, payload?.game);
    const fingerprint = createHash('sha256').update(JSON.stringify({
      roomId: payload?.roomId, slot: payload?.slotName, game: payload?.game, endpoint,
      yaml: String(payload?.yamlContent || ''), environment: environment.fingerprint,
      roomState: String(payload?.stateFingerprint || ''),
    })).digest('hex');
    const analysis = { status, templateUsed, fingerprint, stateFingerprint: String(payload?.stateFingerprint || ''), yamlFingerprint: contentFingerprint(String(payload?.yamlContent || '')), environmentFingerprint: environment.fingerprint, stale: false, analyzedAt: new Date().toISOString(), ...parseUniversalTrackerOutput(sanitized) };
    if (activeShare?.roomId === payload?.roomId) {
      roomPortal.updateLogic(payload?.slot, analysis);
      const target = path.join(activeShare.folderPath, 'logic-analyses.json');
      let saved = {};
      try { saved = JSON.parse(await fs.readFile(target, 'utf8')); } catch { /* First analysis. */ }
      saved[String(payload?.slot)] = analysis;
      await fs.writeFile(target, JSON.stringify(saved), 'utf8');
    }
    return analysis;
  } finally {
    activeGeneratorJobs -= 1;
    await fs.rm(workspace, { recursive: true, force: true });
  }
}));
ipcMain.handle('rooms:cancel-universal-tracker', ipcResult(async (payload) => {
  const key = `${String(payload?.roomId)}:${String(payload?.slotName)}`;
  const child = activeLogicAnalyses.get(key);
  if (!child) return { cancelled: false };
  child.kill();
  activeLogicAnalyses.delete(key);
  return { cancelled: true };
}));

ipcMain.handle('rooms:install-required-apworld', ipcResult(async (payload) => {
  const worldId = String(payload?.worldId || '');
  if (!['tracker', 'slotlock'].includes(worldId)) throw new Error('Only Universal Tracker and SlotLock can be installed from a room action.');
  const [catalog, inventory] = await Promise.all([apWorldService.getCatalog({ maxAgeMs: 24 * 60 * 60 * 1000 }), apWorldService.inventory(payload?.installRoot)]);
  const entry = catalog.entries.find((item) => item.id === worldId);
  if (!entry) throw new Error('This tool is not available in the cached APWorld catalog. Refresh APWorlds and try again.');
  const compatible = entry.releases.filter((release) => {
    const minimum = release.minimumApVersion;
    const maximum = release.maximumApVersion;
    const version = inventory.apVersion;
    const parts = (value) => String(value || '').split(/[^0-9]+/).filter(Boolean).map(Number);
    const compare = (left, right) => { const a = parts(left); const b = parts(right); for (let i = 0; i < Math.max(a.length, b.length); i += 1) { const delta = (a[i] || 0) - (b[i] || 0); if (delta) return delta; } return 0; };
    return (!minimum || compare(version, minimum) >= 0) && (!maximum || compare(version, maximum) <= 0);
  });
  if (!compatible.length) return { installed: false, sourceUrl: entry.sourceUrl, error: 'No indexed release is compatible with this Archipelago installation.' };
  const release = compatible[0];
  await apWorldService.install({ installRoot: payload?.installRoot, worldId, releaseId: release.id });
  return { installed: true, releaseId: release.id, inventory: await apWorldService.inventory(payload?.installRoot), components: await inventoryLauncherComponents(payload?.installRoot) };
}));
ipcMain.handle('rooms:host-api-key', ipcResult(async (payload) => {
  const secretRef = String(payload?.secretRef || 'room-host-api-key');
  if (!/^[A-Za-z0-9:_-]{3,120}$/.test(secretRef)) throw new Error('Invalid host API secret reference.');
  if (payload?.remove) { await setSecret(secretRef, ''); return { configured: false }; }
  const key = randomBytes(32).toString('base64url');
  await setSecret(secretRef, key);
  return { configured: true, key };
}));
ipcMain.handle('poptracker:inventory', ipcResult((executablePath) => inventoryPopTracker(executablePath)));
ipcMain.handle('rooms:launch-poptracker', ipcResult(async (payload) => {
  const inventory = await inventoryPopTracker(payload?.executablePath);
  const pack = inventory.packs.find((item) => item.uid === payload?.packUid);
  if (!pack) throw new Error('The associated PopTracker pack is no longer installed.');
  const status = await currentRoomStatus(payload);
  const endpoint = endpointFor(status);
  const password = await getSecret(payload?.passwordRef);
  const args = popTrackerArgs(pack, payload?.variant, {
    host: `${endpoint.host}:${endpoint.port}`,
    slot: String(payload?.slotName ?? ''),
    password,
  });
  const executable = path.resolve(String(payload?.executablePath ?? ''));
  const child = spawn(executable, args, { cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { status, pack: { uid: pack.uid, name: pack.name, version: pack.version }, variant: payload?.variant };
}));

ipcMain.handle('rooms:launch-profile', ipcResult(async (payload) => {
  const status = await currentRoomStatus(payload);
  const endpoint = endpointFor(status);
  const roomFolder = rooms.inside(payload?.roomsRoot, payload?.roomFolder);
  const slotName = String(payload?.slotName ?? '').trim();
  if (!path.isAbsolute(roomFolder) || !slotName || slotName.length > 100) throw new Error('Invalid room launch context.');
  const selectedFile = payload?.selectedFile ? path.resolve(String(payload.selectedFile)) : '';
  if (selectedFile && !rooms.inside(roomFolder, selectedFile)) throw new Error('The selected launch file is outside this room.');
  const slotFolder = path.join(roomFolder, 'play', rooms.safeName(slotName, 'slot'));
  const context = {
    server: endpoint.host,
    port: endpoint.port,
    endpoint: `${endpoint.host}:${endpoint.port}`,
    slot: slotName,
    game: String(payload?.game ?? ''),
    roomUrl: String(payload?.roomUrl ?? ''),
    roomFolder,
    slotFolder,
    selectedFile,
  };
  const result = await launchProfile(payload?.profile, context, { openExternal: (url) => shell.openExternal(url), openPath: (target) => shell.openPath(target), spawn }, payload?.stage);
  return { status, launched: result.launched, deferred: result.deferred };
}));

ipcMain.handle('minecraft:inventory', ipcResult(() => inventoryMinecraftLauncher()));

ipcMain.handle('tools:open-patch', ipcResult(async (installRoot) => {
  const result = await dialog.showOpenDialog({
    title: 'Open Archipelago patch',
    properties: ['openFile'],
    filters: [
      { name: 'Archipelago patch or game file', extensions: ['archipelago', 'apmc', 'apsm', 'aplttp', 'apsmz3', 'apsoe', 'apbp', 'apdp', 'apdkc3', 'apladx', 'apoot', 'aptloz'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return launchArchipelagoLauncher(installRoot, result.filePaths[0]);
}));

function remoteUrl(address) {
  const value = String(address ?? '').trim();
  if (!value) throw new Error('Enter a room address.');
  if (/^wss?:\/\//i.test(value)) return value;
  const host = value.split(':')[0].toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return `${local ? 'ws' : 'wss'}://${value}`;
}

function printJsonText(packet) {
  return Array.isArray(packet.data)
    ? packet.data.map((part) => typeof part === 'string' ? part : part?.text ?? '').join('')
    : '';
}

function scheduleRemoteReconnect(session, message) {
  if (remoteConsole !== session || session.manualClose || quitting) return;
  session.state = 'disconnected';
  sendRemoteStatus(session.sender, 'disconnected', message);
  const delay = Math.min(30, 5 * (2 ** session.retry++));
  sendConsole(session.sender, 'remote', `${message} Reconnecting in ${delay} seconds...`, 'error');
  session.reconnectTimer = setTimeout(() => void openRemoteConsole(session).catch((error) => scheduleRemoteReconnect(session, `Reconnect failed: ${error.message}.`)), delay * 1000);
}

async function openRemoteConsole(session) {
  if (remoteConsole !== session || session.manualClose) return;
  if (session.profile.roomUrl) {
    const status = await currentRoomStatus({ roomUrl: session.profile.roomUrl, provider: session.profile.roomProvider, roomId: session.profile.roomId });
    const endpoint = endpointFor(status);
    session.profile.address = `${endpoint.host}:${endpoint.port}`;
  }
  const url = remoteUrl(session.profile.address);
  session.state = 'connecting';
  sendRemoteStatus(session.sender, 'connecting', url);
  sendConsole(session.sender, 'remote', `Connecting to ${url}...`);
  const socket = new net.WebSocket(url);
  session.socket = socket;

  socket.addEventListener('message', (event) => {
    if (remoteConsole !== session) return;
    let packets;
    try { packets = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()); }
    catch { sendConsole(session.sender, 'remote', 'The server sent an unreadable packet.', 'error'); return; }
    for (const packet of Array.isArray(packets) ? packets : [packets]) {
      if (packet.cmd === 'RoomInfo') {
        socket.send(JSON.stringify([{ cmd: 'Connect', password: session.roomPassword, name: session.profile.slotName,
          version: { major: 0, minor: 6, build: 7, class: 'Version' }, tags: ['AP', 'IgnoreGame', 'TextOnly'],
          items_handling: 0, uuid: session.uuid, game: '', slot_data: false }]));
      } else if (packet.cmd === 'Connected') {
        session.retry = 0;
        session.state = 'chat';
        sendRemoteStatus(session.sender, 'chat', session.profile.label);
        sendConsole(session.sender, 'remote', `Connected as ${session.profile.slotName}.`, 'info');
        if (session.adminPassword) socket.send(JSON.stringify([{ cmd: 'Say', text: `!admin login ${session.adminPassword}` }]));
      } else if (packet.cmd === 'ConnectionRefused') {
        const errors = Array.isArray(packet.errors) ? packet.errors.join(', ') : 'Connection refused';
        sendConsole(session.sender, 'remote', errors, 'error');
        sendRemoteStatus(session.sender, 'disconnected', errors);
      } else if (packet.cmd === 'Print') {
        sendConsole(session.sender, 'remote', packet.text, 'message');
      } else if (packet.cmd === 'PrintJSON') {
        const message = printJsonText(packet);
        if (!message) continue;
        if (/login successful/i.test(message)) {
          session.state = 'admin';
          sendRemoteStatus(session.sender, 'admin', session.profile.label);
          sendConsole(session.sender, 'remote', 'Remote administration enabled.', 'info');
        } else if (/password incorrect|remote administration is disabled|must first login/i.test(message)) {
          session.state = 'chat';
          sendRemoteStatus(session.sender, 'chat', message);
          sendConsole(session.sender, 'remote', message, 'error');
        } else if (!/!admin login/i.test(message)) {
          sendConsole(session.sender, 'remote', message, packet.type === 'AdminCommandResult' ? 'command' : 'message');
        }
      }
    }
  });
  socket.addEventListener('error', () => {
    if (remoteConsole === session) sendConsole(session.sender, 'remote', 'Remote connection error.', 'error');
  });
  socket.addEventListener('close', (event) => {
    if (remoteConsole !== session) return;
    session.socket = null;
    session.state = 'disconnected';
    sendRemoteStatus(session.sender, 'disconnected', event.reason || 'Connection closed');
    if (session.manualClose || quitting) {
      sendConsole(session.sender, 'remote', 'Remote console disconnected.');
      remoteConsole = null;
      return;
    }
    scheduleRemoteReconnect(session, 'Connection lost.');
  });
}

ipcMain.handle('remote:connect', async (event, profile) => {
  if (activeHost && activeHost.exitCode === null) return { ok: false, error: 'Stop the local host before connecting remotely.' };
  if (!profile?.address || !profile?.slotName) return { ok: false, error: 'A room address and slot name are required.' };
  if (remoteConsole) {
    remoteConsole.manualClose = true;
    if (remoteConsole.reconnectTimer) clearTimeout(remoteConsole.reconnectTimer);
    remoteConsole.socket?.close();
  }
  const session = {
    profile, sender: event.sender, socket: null, reconnectTimer: null, retry: 0, manualClose: false,
    state: 'connecting', uuid: randomUUID(), roomPassword: await getSecret(profile.roomPasswordRef),
    adminPassword: await getSecret(profile.serverPasswordRef),
  };
  remoteConsole = session;
  try { await openRemoteConsole(session); return { ok: true }; }
  catch (error) { remoteConsole = null; return { ok: false, error: error.message }; }
});

ipcMain.handle('remote:disconnect', () => {
  if (!remoteConsole) return { ok: true };
  remoteConsole.manualClose = true;
  if (remoteConsole.reconnectTimer) clearTimeout(remoteConsole.reconnectTimer);
  remoteConsole.socket?.close();
  remoteConsole = null;
  return { ok: true };
});

ipcMain.handle('remote:status', () => ({ state: remoteConsole?.state ?? 'disconnected', profileId: remoteConsole?.profile?.id }));

ipcMain.handle('remote:send', (_event, raw) => {
  const text = String(raw ?? '').trim();
  if (!remoteConsole?.socket || remoteConsole.socket.readyState !== 1) return { ok: false, error: 'Remote console is not connected.' };
  if (!text || text.length > 1000) return { ok: false, error: 'Commands must contain between 1 and 1000 characters.' };
  if (/^!admin\s+login\b/i.test(text)) return { ok: false, error: 'Use the saved server password to log in securely.' };
  if (text.startsWith('/') && remoteConsole.state !== 'admin') return { ok: false, error: 'Remote admin access is not active.' };
  const outgoing = text.startsWith('/') ? `!admin ${text}` : text;
  remoteConsole.socket.send(JSON.stringify([{ cmd: 'Say', text: outgoing }]));
  sendConsole(remoteConsole.sender, 'remote', `> ${text}`, 'command');
  return { ok: true };
});

ipcMain.handle('remote:admin-login', async (_event, secretRef) => {
  if (!remoteConsole?.socket || remoteConsole.socket.readyState !== 1 || remoteConsole.state === 'connecting') {
    return { ok: false, error: 'Remote console is not connected.' };
  }
  const password = await getSecret(secretRef);
  if (!password) return { ok: false, error: 'Save a server password before logging in as admin.' };
  remoteConsole.adminPassword = password;
  remoteConsole.socket.send(JSON.stringify([{ cmd: 'Say', text: `!admin login ${password}` }]));
  sendConsole(remoteConsole.sender, 'remote', 'Requesting remote administration...', 'info');
  return { ok: true };
});

function seedFromName(fileName) {
  return fileName.match(/AP_(\d+)/i)?.[1] || null;
}

function spoilerSummary(content) {
  const slots = [];
  const games = [];
  const pattern = /^Player \d+:\s*(.+)\r?\nGame:\s*(.+)$/gm;
  for (const match of content.matchAll(pattern)) {
    slots.push(match[1].trim());
    games.push(match[2].trim());
  }
  const people = new Set(slots.map((name) => name.split('_')[0].toLowerCase()));
  return { playerCount: people.size || slots.length, slotCount: slots.length, games: [...new Set(games)], slots: slots.map((name, index) => ({ name, game: games[index] || 'Unknown game' })) };
}

ipcMain.handle('history:scan-existing', async (_event, payload) => {
  const runs = [];
  const hostedSeeds = new Set();
  try {
    const folders = await fs.readdir(payload.hostedRoot, { withFileTypes: true });
    for (const folder of folders.filter((entry) => entry.isDirectory())) {
      const folderPath = path.join(payload.hostedRoot, folder.name);
      const artifact = await firstMatchingFile(folderPath, ['.archipelago']);
      if (!artifact) continue;
      const seed = seedFromName(path.basename(artifact));
      if (seed) hostedSeeds.add(seed);
      const spoiler = await firstMatchingFile(folderPath, ['_spoiler.txt']);
      const savePath = await firstMatchingFile(folderPath, ['.apsave']);
      let summary = { playerCount: 0, slotCount: 0, games: [], slots: [] };
      if (spoiler) summary = spoilerSummary(await fs.readFile(spoiler, 'utf8'));
      const stats = await fs.stat(artifact);
      runs.push({
        importKey: seed ? `seed:${seed}` : `artifact:${artifact.toLowerCase()}`,
        name: folder.name,
        createdAt: stats.mtime.toISOString(),
        outputPath: folderPath,
        artifactPath: artifact,
        savePath,
        seed,
        ...summary,
      });
    }
  } catch { /* An optional history folder may not exist yet. */ }

  try {
    const files = await fs.readdir(payload.outputRoot, { withFileTypes: true });
    for (const file of files.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))) {
      const seed = seedFromName(file.name);
      if (seed && hostedSeeds.has(seed)) continue;
      const artifact = path.join(payload.outputRoot, file.name);
      const stats = await fs.stat(artifact);
      const summary = await rooms.archiveSlotSummary(artifact);
      runs.push({
        importKey: seed ? `seed:${seed}` : `artifact:${artifact.toLowerCase()}`,
        name: seed ? `Seed ${seed}` : path.basename(file.name, '.zip'),
        createdAt: stats.mtime.toISOString(),
        outputPath: artifact,
        artifactPath: artifact,
        savePath: null,
        seed,
        ...summary,
      });
    }
  } catch { /* An optional output folder may not exist yet. */ }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

ipcMain.handle('library:save-files', async (_event, payload) => {
  if (!payload.root) return payload.files.map((file) => file.sourcePath);
  return Promise.all(payload.files.map(async (file) => {
    const gameFolder = file.game.replace(/[^a-z0-9_-]+/gi, '') || 'UnknownGame';
    const fileName = file.name.replace(/[^a-z0-9_.-]+/gi, '') || 'Imported.yaml';
    const targetFolder = path.join(payload.root, gameFolder);
    const targetPath = path.join(targetFolder, fileName);
    await fs.mkdir(targetFolder, { recursive: true });
    await fs.writeFile(targetPath, file.content, { encoding: 'utf8', flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      const existingContent = await fs.readFile(targetPath, 'utf8');
      if (existingContent.replace(/\r\n/g, '\n').trim() === file.content.replace(/\r\n/g, '\n').trim()) {
        file.resolvedPath = targetPath;
        return;
      }
      const stem = path.basename(fileName, path.extname(fileName));
      const alternate = path.join(targetFolder, `${stem}-${Date.now()}${path.extname(fileName)}`);
      await fs.writeFile(alternate, file.content, 'utf8');
      file.resolvedPath = alternate;
    });
    return file.resolvedPath || targetPath;
  }));
});

function tokenizeArgs(template, replacements) {
  const expanded = Object.entries(replacements).reduce(
    (value, [key, replacement]) => value.replaceAll(`{${key}}`, replacement),
    template,
  );
  return expanded.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((arg) => arg.replace(/^"|"$/g, '')) ?? [];
}

function runProcess(command, args, sender, cwd = path.dirname(command)) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, cwd });
    child.stdout.on('data', (chunk) => sender.send('process:log', chunk.toString()));
    child.stderr.on('data', (chunk) => sender.send('process:log', chunk.toString()));
    child.on('error', (error) => resolve({ ok: false, exitCode: -1, error: error.message }));
    child.on('close', (exitCode) => resolve({ ok: exitCode === 0, exitCode, error: exitCode === 0 ? null : `Process exited with code ${exitCode}` }));
  });
}

async function firstMatchingFile(root, extensions) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = await firstMatchingFile(candidate, extensions);
        if (nested) return nested;
      } else if (extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) {
        return candidate;
      }
    }
  } catch { return null; }
  return null;
}

ipcMain.handle('session:generate', async (event, payload) => {
  const safeName = payload.sessionName.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'session';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const root = path.join(payload.outputRoot, `${stamp}_${safeName}`);
  const input = path.join(root, 'players');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await Promise.all(payload.files.map((file) => fs.writeFile(path.join(input, file.name), file.content, 'utf8')));
  const hostDocument = YAML.parse(payload.hostYaml) || {};
  hostDocument.server_options ||= {};
  hostDocument.server_options.password = await getSecret(payload.hostSettings?.roomPasswordRef) || null;
  hostDocument.server_options.server_password = await getSecret(payload.hostSettings?.serverPasswordRef) || null;
  await fs.writeFile(path.join(root, 'host.yaml'), YAML.stringify(hostDocument), 'utf8');
  await fs.writeFile(path.join(root, 'session.json'), JSON.stringify(payload.metadata, null, 2), 'utf8');

  const generatorPath = executablePath(payload.installRoot, 'ArchipelagoGenerate.exe');
  if (!await fs.access(generatorPath).then(() => true).catch(() => false)) return { ok: false, outputPath: root, error: 'ArchipelagoGenerate.exe was not found in the installation folder.' };
  const args = tokenizeArgs(payload.generatorArgs, { input, output, root });
  activeGeneratorJobs += 1;
  let result;
  let artifactPath;
  try { result = await runProcess(generatorPath, args, event.sender, root); }
  finally { activeGeneratorJobs -= 1; }
  if (result.ok) {
    const zip = await firstMatchingFile(output, ['.zip']);
    if (zip) {
      artifactPath = zip;
      const unpacked = path.join(root, 'unpacked');
      await fs.mkdir(unpacked, { recursive: true });
      await extractZip(zip, unpacked);
      event.sender.send('process:log', `Unpacked ${path.basename(zip)} to ${unpacked}\n`);
    }
  }
  return { ...result, outputPath: root, artifactPath };
});

ipcMain.handle('session:dry-run', async (event, payload) => {
  const generatorPath = executablePath(payload.installRoot, 'ArchipelagoGenerate.exe');
  if (!await fs.access(generatorPath).then(() => true).catch(() => false)) return { ok: false, exitCode: -1, error: 'ArchipelagoGenerate.exe was not found in the installation folder.' };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archipelago-controller-'));
  const input = path.join(root, 'players');
  const output = path.join(root, 'output');
  try {
    await fs.mkdir(input, { recursive: true });
    await fs.mkdir(output, { recursive: true });
    await Promise.all(payload.files.map((file) => fs.writeFile(path.join(input, file.name), file.content, 'utf8')));
    const args = [...tokenizeArgs(payload.generatorArgs, { input, output, root }), '--skip_output'];
    activeGeneratorJobs += 1;
    try { return await runProcess(generatorPath, args, event.sender); }
    finally { activeGeneratorJobs -= 1; }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

ipcMain.handle('session:host', async (event, payload) => {
  if (activeHost && activeHost.exitCode === null) return { ok: false, error: 'A local host is already running.' };
  if (remoteConsole) return { ok: false, error: 'Disconnect the remote console before starting a local host.' };
  const hostPath = executablePath(payload.installRoot, 'ArchipelagoServer.exe');
  if (!await fs.access(hostPath).then(() => true).catch(() => false)) return { ok: false, exitCode: -1, error: 'ArchipelagoServer.exe was not found in the installation folder.' };
  let target = null;
  if (payload.artifactPath) target = payload.artifactPath;
  else if (payload.sessionPath) {
    try {
      const stats = await fs.stat(payload.sessionPath);
      target = stats.isFile() ? payload.sessionPath : await firstMatchingFile(payload.sessionPath, ['.archipelago', '.zip']);
    } catch { target = null; }
  }
  if (!target) return { ok: false, exitCode: -1, error: 'No generated .archipelago or .zip file was found.' };
  let workingDirectory = path.dirname(hostPath);
  if (payload.sessionPath) {
    try {
      const stats = await fs.stat(payload.sessionPath);
      if (stats.isDirectory() && await fs.access(path.join(payload.sessionPath, 'host.yaml')).then(() => true).catch(() => false)) workingDirectory = payload.sessionPath;
    } catch { /* Use the installation defaults. */ }
  }
  const settings = payload.hostSettings || {};
  const args = [target];
  const bindAddress = String(settings.host || '').trim();
  // Let Archipelago create its normal dual-stack listener for wildcard binds.
  // An explicit 0.0.0.0 listener can make localhost-first clients fail on ::1.
  if (bindAddress && bindAddress !== '0.0.0.0' && bindAddress !== '::' && bindAddress !== '[::]') {
    args.push('--host', bindAddress);
  }
  if (settings.port) args.push('--port', String(settings.port));
  const roomPassword = await getSecret(settings.roomPasswordRef);
  const serverPassword = await getSecret(settings.serverPasswordRef);
  if (roomPassword) args.push('--password', roomPassword);
  if (serverPassword) args.push('--server_password', serverPassword);
  if (payload.savePath) args.push('--savefile', payload.savePath);
  else if (settings.savefile) args.push('--savefile', settings.savefile);
  if (settings.logLevel) args.push('--loglevel', settings.logLevel);
  if (settings.autoShutdown) args.push('--auto_shutdown', String(settings.autoShutdown));
  return new Promise((resolve) => {
    const child = spawn(hostPath, args, { windowsHide: true, cwd: workingDirectory });
    activeHost = child;
    activeHostMeta = { roomId: payload.roomId || null, port: Number(settings.port) || 38281, sessionPath: payload.sessionPath, savePath: payload.savePath || settings.savefile || null };
    child.stdout.on('data', (chunk) => sendHostOutput(event.sender, chunk, 'message'));
    child.stderr.on('data', (chunk) => sendHostOutput(event.sender, chunk, 'error'));
    child.once('spawn', () => {
      if (activeHostMeta.roomId && Array.isArray(payload.slots) && payload.slots.length) {
        trackerSidecar.start({ roomId: activeHostMeta.roomId, port: activeHostMeta.port, password: roomPassword, slots: payload.slots });
      }
      if (activeShare?.roomId === activeHostMeta.roomId) {
        activeShare.portalConfig.serverRunning = true;
        void publishShareStatus({ roomId: activeShare.roomId, state: 'sharing', serverRunning: true, portalRunning: true, mapping: activeShare.result.mapping, reachability: 'unknown', publicUrl: `${activeShare.baseUrl}/room/${activeShare.roomId}` });
      }
      event.sender.send('host:status', { running: true, pid: child.pid, roomId: activeHostMeta.roomId, port: activeHostMeta.port, savePath: activeHostMeta.savePath });
      resolve({ ok: true, pid: child.pid, roomId: activeHostMeta.roomId, port: activeHostMeta.port });
    });
    child.once('error', (error) => {
      trackerSidecar.stop();
      roomPortal.updateTracker(undefined);
      activeHost = null;
      activeHostMeta = null;
      event.sender.send('host:status', { running: false, error: error.message });
      resolve({ ok: false, error: error.message });
    });
    child.once('close', (exitCode) => {
      const stoppedRoomId = activeHostMeta?.roomId;
      activeHost = null;
      activeHostMeta = null;
      trackerSidecar.stop();
      roomPortal.updateTracker(undefined);
      if (activeShare?.roomId === stoppedRoomId) {
        activeShare.portalConfig.serverRunning = false;
        void publishShareStatus({ roomId: activeShare.roomId, state: 'sharing', serverRunning: false, portalRunning: true, mapping: activeShare.result.mapping, reachability: 'unknown', publicUrl: `${activeShare.baseUrl}/room/${activeShare.roomId}` });
      }
      if (!event.sender.isDestroyed()) event.sender.send('host:status', { running: false, exitCode, roomId: stoppedRoomId });
    });
  });
});

ipcMain.handle('session:host-status', () => ({ running: Boolean(activeHost && activeHost.exitCode === null), pid: activeHost?.pid ?? null, ...activeHostMeta }));

ipcMain.handle('session:host-input', (event, raw) => {
  const text = String(raw ?? '').trim();
  if (!activeHost || activeHost.exitCode !== null || !activeHost.stdin?.writable) return { ok: false, error: 'The local host is not running.' };
  if (!text || text.length > 1000) return { ok: false, error: 'Commands must contain between 1 and 1000 characters.' };
  if (text.startsWith('!')) return { ok: false, error: 'Use the corresponding / command in the local host console.' };
  activeHost.stdin.write(`${text}${os.EOL}`);
  sendConsole(event.sender, 'local', `> ${text}`, 'command');
  return { ok: true };
});

ipcMain.handle('session:stop-host', async (event) => {
  if (!activeHost || activeHost.exitCode !== null) return { ok: true, running: false };
  const child = activeHost;
  const pid = activeHost.pid;
  if (child.stdin?.writable) child.stdin.write(`/exit${os.EOL}`);
  event.sender.send('process:log', `Stopping local host process ${pid}...\n`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (child.exitCode === null) child.kill();
  return { ok: true, running: child.exitCode === null };
});
