const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('archipelago', {
  pickYamlFiles: () => ipcRenderer.invoke('files:pick-yaml'),
  readYamlDirectory: (directoryPath) => ipcRenderer.invoke('files:read-yaml-directory', directoryPath),
  pickDirectory: (title) => ipcRenderer.invoke('files:pick-directory', title),
  pickExecutable: (title) => ipcRenderer.invoke('files:pick-executable', title),
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
  onYamlValidationProgress: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('yaml:validation-progress', handler);
    return () => ipcRenderer.removeListener('yaml:validation-progress', handler);
  },
});
