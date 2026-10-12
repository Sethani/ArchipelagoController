const { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { extractZip } = require('./archive.cjs');
const { createApWorldService } = require('./apworlds.cjs');
const { createYamlValidator } = require('./yaml-validation.cjs');
const { inventoryLauncherComponents } = require('./launcher-components.cjs');
const { createApUpdateService } = require('./ap-update.cjs');
const { readHostConfig, writeHostConfig } = require('./host-config.cjs');
const YAML = require('yaml');

const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke') || process.env.ARCHIPELAGO_CONTROLLER_SMOKE === '1';
let activeHost = null;
let remoteConsole = null;
let quitting = false;
let mainWindow = null;
let activeGeneratorJobs = 0;
let validationBusy = false;

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

function sendConsole(sender, target, text, level = 'info') {
  if (!sender || sender.isDestroyed() || !text) return;
  sender.send('console:event', { target, level, text: String(text).trimEnd(), timestamp: new Date().toISOString() });
}

function sendHostOutput(sender, chunk, fallbackLevel) {
  for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('before-quit', () => {
  quitting = true;
  if (remoteConsole?.reconnectTimer) clearTimeout(remoteConsole.reconnectTimer);
  remoteConsole?.socket?.close();
  if (activeHost && activeHost.exitCode === null) activeHost.kill();
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
  const child = spawn(launcher, argument ? [argument] : [], { cwd: root, detached: true, stdio: 'ignore', windowsHide: false });
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

async function openRemoteConsole(session) {
  if (remoteConsole !== session || session.manualClose) return;
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
    const delay = Math.min(30, 5 * (2 ** session.retry++));
    sendConsole(session.sender, 'remote', `Connection lost. Reconnecting in ${delay} seconds...`, 'error');
    session.reconnectTimer = setTimeout(() => void openRemoteConsole(session), delay * 1000);
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
      runs.push({
        importKey: seed ? `seed:${seed}` : `artifact:${artifact.toLowerCase()}`,
        name: seed ? `Seed ${seed}` : path.basename(file.name, '.zip'),
        createdAt: stats.mtime.toISOString(),
        outputPath: artifact,
        artifactPath: artifact,
        savePath: null,
        seed,
        playerCount: 0,
        slotCount: 0,
        games: [],
        slots: [],
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
  try { result = await runProcess(generatorPath, args, event.sender, root); }
  finally { activeGeneratorJobs -= 1; }
  if (result.ok) {
    const zip = await firstMatchingFile(output, ['.zip']);
    if (zip) {
      const unpacked = path.join(root, 'unpacked');
      await fs.mkdir(unpacked, { recursive: true });
      await extractZip(zip, unpacked);
      event.sender.send('process:log', `Unpacked ${path.basename(zip)} to ${unpacked}\n`);
    }
  }
  return { ...result, outputPath: root };
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
    child.stdout.on('data', (chunk) => sendHostOutput(event.sender, chunk, 'message'));
    child.stderr.on('data', (chunk) => sendHostOutput(event.sender, chunk, 'error'));
    child.once('spawn', () => {
      event.sender.send('host:status', { running: true, pid: child.pid });
      resolve({ ok: true, pid: child.pid });
    });
    child.once('error', (error) => {
      activeHost = null;
      event.sender.send('host:status', { running: false, error: error.message });
      resolve({ ok: false, error: error.message });
    });
    child.once('close', (exitCode) => {
      activeHost = null;
      if (!event.sender.isDestroyed()) event.sender.send('host:status', { running: false, exitCode });
    });
  });
});

ipcMain.handle('session:host-status', () => ({ running: Boolean(activeHost && activeHost.exitCode === null), pid: activeHost?.pid ?? null }));

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
