const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('archipelago', {
  pickYamlFiles: () => ipcRenderer.invoke('files:pick-yaml'),
  readYamlDirectory: (directoryPath) => ipcRenderer.invoke('files:read-yaml-directory', directoryPath),
  pickDirectory: (title) => ipcRenderer.invoke('files:pick-directory', title),
  pickExecutable: (title) => ipcRenderer.invoke('files:pick-executable', title),
  pickLaunchFile: (title) => ipcRenderer.invoke('files:pick-launch-file', title),
  pickLaunchShortcut: () => ipcRenderer.invoke('files:pick-launch-shortcut'),
  pickSteamSourceMod: () => ipcRenderer.invoke('files:pick-steam-source-mod'),
  pickApWorld: () => ipcRenderer.invoke('files:pick-apworld'),
  exportYaml: (payload) => ipcRenderer.invoke('files:export-yaml', payload),
  exportYamlPack: (payload) => ipcRenderer.invoke('files:export-yaml-pack', payload),
  exists: (filePath) => ipcRenderer.invoke('files:exists', filePath),
  reveal: (targetPath) => ipcRenderer.invoke('files:reveal', targetPath),
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  inventoryTools: (installRoot) => ipcRenderer.invoke('tools:inventory', installRoot),
  checkArchipelagoUpdate: (payload) => ipcRenderer.invoke('archipelago:update-status', payload),
  readHostConfig: (installRoot) => ipcRenderer.invoke('host-config:read', installRoot),
  writeHostConfig: (payload) => ipcRenderer.invoke('host-config:write', payload),
  inventoryApWorlds: (installRoot) => ipcRenderer.invoke('apworlds:inventory', installRoot),
  getApWorldCatalog: (options) => ipcRenderer.invoke('apworlds:catalog', options),
  refreshApWorldCatalog: () => ipcRenderer.invoke('apworlds:refresh'),
  installApWorld: (payload) => ipcRenderer.invoke('apworlds:install', payload),
  importApWorld: (payload) => ipcRenderer.invoke('apworlds:import', payload),
  removeApWorld: (payload) => ipcRenderer.invoke('apworlds:remove', payload),
  resolveYamlGames: (payload) => ipcRenderer.invoke('yaml:resolve-games', payload),
  validateYamls: (payload) => ipcRenderer.invoke('yaml:validate', payload),
  cancelYamlValidation: () => ipcRenderer.invoke('yaml:cancel-validation'),
  launchTool: (executablePath) => ipcRenderer.invoke('tools:launch', executablePath),
  launchApWorldComponent: (payload) => ipcRenderer.invoke('tools:launch-component', payload),
  openPatch: (installRoot) => ipcRenderer.invoke('tools:open-patch', installRoot),
  inspectRoom: (payload) => ipcRenderer.invoke('rooms:inspect', payload),
  takeRoomInvite: () => ipcRenderer.invoke('rooms:take-invite'),
  ensureRoom: (payload) => ipcRenderer.invoke('rooms:ensure', payload),
  adoptLocalRoom: (payload) => ipcRenderer.invoke('rooms:adopt-local', payload),
  listRoomFiles: (payload) => ipcRenderer.invoke('rooms:list-files', payload),
  downloadRoomSlot: (payload) => ipcRenderer.invoke('rooms:download-slot', payload),
  importRoomFile: (payload) => ipcRenderer.invoke('rooms:import-file', payload),
  launchRoomFile: (payload) => ipcRenderer.invoke('rooms:launch-file', payload),
  launchRoomClient: (payload) => ipcRenderer.invoke('rooms:launch-client', payload),
  openRoomTracker: (payload) => ipcRenderer.invoke('rooms:open-tracker', payload),
  openRoomSphereTracker: (payload) => ipcRenderer.invoke('rooms:open-sphere-tracker', payload),
  getRoomTrackerDashboard: (payload) => ipcRenderer.invoke('rooms:tracker-dashboard', payload),
  launchRoomUniversalTracker: (payload) => ipcRenderer.invoke('rooms:launch-universal-tracker', payload),
  analyzeRoomUniversalTracker: (payload) => ipcRenderer.invoke('rooms:analyze-universal-tracker', payload),
  inventoryPopTracker: (executablePath) => ipcRenderer.invoke('poptracker:inventory', executablePath),
  inventoryMinecraftLauncher: () => ipcRenderer.invoke('minecraft:inventory'),
  launchRoomPopTracker: (payload) => ipcRenderer.invoke('rooms:launch-poptracker', payload),
  launchRoomProfile: (payload) => ipcRenderer.invoke('rooms:launch-profile', payload),
  startRoomSharing: (payload) => ipcRenderer.invoke('rooms:start-sharing', payload),
  stopRoomSharing: (payload) => ipcRenderer.invoke('rooms:stop-sharing', payload),
  copyRoomInvite: (payload) => ipcRenderer.invoke('rooms:copy-invite', payload),
  openRoomShare: (payload) => ipcRenderer.invoke('rooms:open-share', payload),
  roomShareStatus: () => ipcRenderer.invoke('rooms:share-status'),
  saveLibraryFiles: (payload) => ipcRenderer.invoke('library:save-files', payload),
  scanExistingHistory: (payload) => ipcRenderer.invoke('history:scan-existing', payload),
  generate: (payload) => ipcRenderer.invoke('session:generate', payload),
  dryRun: (payload) => ipcRenderer.invoke('session:dry-run', payload),
  host: (payload) => ipcRenderer.invoke('session:host', payload),
  hostStatus: () => ipcRenderer.invoke('session:host-status'),
  sendHostInput: (value) => ipcRenderer.invoke('session:host-input', value),
  stopHost: () => ipcRenderer.invoke('session:stop-host'),
  setSecret: (payload) => ipcRenderer.invoke('secrets:set', payload),
  removeSecret: (id) => ipcRenderer.invoke('secrets:remove', id),
  connectRemote: (profile) => ipcRenderer.invoke('remote:connect', profile),
  disconnectRemote: () => ipcRenderer.invoke('remote:disconnect'),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  sendRemoteInput: (value) => ipcRenderer.invoke('remote:send', value),
  remoteAdminLogin: (secretRef) => ipcRenderer.invoke('remote:admin-login', secretRef),
  onLog: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('process:log', handler);
    return () => ipcRenderer.removeListener('process:log', handler);
  },
  onHostStatus: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('host:status', handler);
    return () => ipcRenderer.removeListener('host:status', handler);
  },
  onConsoleEvent: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('console:event', handler);
    return () => ipcRenderer.removeListener('console:event', handler);
  },
  onRemoteStatus: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('remote:status', handler);
    return () => ipcRenderer.removeListener('remote:status', handler);
  },
  onRoomShareStatus: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('rooms:share-status', handler);
    return () => ipcRenderer.removeListener('rooms:share-status', handler);
  },
  onRoomInvite: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('rooms:invite', handler);
    return () => ipcRenderer.removeListener('rooms:invite', handler);
  },
  onYamlValidationProgress: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('yaml:validation-progress', handler);
    return () => ipcRenderer.removeListener('yaml:validation-progress', handler);
  },
});
