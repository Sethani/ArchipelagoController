const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_TEMPLATE_LENGTH = 4096;
const ALLOWED_URI_SCHEMES = new Set(['http:', 'https:', 'steam:', 'r2modman:', 'ror2mm:']);

function text(value, name, max = MAX_TEMPLATE_LENGTH) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new Error(`${name} is too long.`);
  return result;
}

function interpolate(template, context) {
  const value = String(template ?? '');
  return value.replace(/\{(server|port|endpoint|slot|game|roomUrl|roomFolder|slotFolder|selectedFile)\}/g, (_match, key) => String(context[key] ?? ''));
}

function splitArguments(value) {
  const args = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const character of String(value ?? '')) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote === '"') { escaped = true; continue; }
    if ((character === '"' || character === "'") && (!quote || quote === character)) { quote = quote ? '' : character; continue; }
    if (/\s/.test(character) && !quote) {
      if (current) { args.push(current); current = ''; }
      continue;
    }
    current += character;
  }
  if (quote) throw new Error('Launch arguments contain an unclosed quote.');
  if (current) args.push(current);
  return args;
}

function validateAction(raw, label = 'Launch action') {
  const type = text(raw?.type, `${label} type`, 20);
  if (!['steam', 'program', 'url', 'file', 'minecraft'].includes(type)) throw new Error(`${label} has an unsupported type.`);
  const action = { type, arguments: text(raw?.arguments, `${label} arguments`) };
  if (type === 'steam') {
    action.steamMode = ['game', 'source'].includes(raw?.steamMode) ? raw.steamMode : 'app';
    action.appId = text(raw?.appId, 'Steam App ID', 20);
    if (!/^\d{2,20}$/.test(action.appId)) throw new Error(`Enter a numeric Steam ${action.steamMode === 'game' ? 'game ID' : 'App ID'}.`);
    action.sourceModPath = text(raw?.sourceModPath, 'Source mod folder', 1000);
    if (action.steamMode === 'source' && !path.isAbsolute(action.sourceModPath)) throw new Error('Choose an absolute Source mod folder.');
  } else if (type === 'program') {
    action.path = text(raw?.path, 'Program path', 1000);
    action.workingDirectory = text(raw?.workingDirectory, 'Working directory', 1000);
    if (!action.path) throw new Error('Choose a program to launch.');
  } else if (type === 'minecraft') {
    action.launcherPath = text(raw?.launcherPath, 'Minecraft Launcher path', 1000);
    action.minecraftRoot = text(raw?.minecraftRoot, 'Minecraft folder', 1000);
    action.minecraftProfileId = text(raw?.minecraftProfileId, 'Minecraft profile ID', 200);
    action.minecraftProfileName = text(raw?.minecraftProfileName, 'Minecraft profile name', 200);
    action.minecraftVersion = text(raw?.minecraftVersion, 'Minecraft version', 200);
    if (!path.isAbsolute(action.launcherPath) || !path.isAbsolute(action.minecraftRoot) || !action.minecraftProfileId || !action.minecraftVersion) {
      throw new Error('Choose an installed Minecraft profile and launcher.');
    }
  } else {
    action.target = text(raw?.target, type === 'url' ? 'URL' : 'File', 2000);
    if (!action.target) throw new Error(type === 'url' ? 'Enter a URL to open.' : 'Choose a file to open.');
  }
  return action;
}

function validateProfile(raw) {
  const profile = {
    id: text(raw?.id, 'Profile ID', 120),
    game: text(raw?.game, 'Game', 200),
    label: text(raw?.label, 'Profile name', 200),
    primary: validateAction(raw?.primary, 'Primary action'),
    companion: raw?.companion ? validateAction(raw.companion, 'Companion action') : undefined,
    companionMode: raw?.companionMode === 'manual' ? 'manual' : 'automatic',
    companionLabel: text(raw?.companionLabel, 'Companion button label', 80),
  };
  if (!profile.id || !profile.game || !profile.label) throw new Error('Launch profile identity is incomplete.');
  return profile;
}

function actionFromShortcut(shortcut) {
  const target = text(shortcut?.target, 'Shortcut target', 2000);
  const args = text(shortcut?.args, 'Shortcut arguments');
  const steamUri = target.match(/^steam:\/\/(run|rungameid)\/(\d+)/i);
  if (steamUri) return { type: 'steam', steamMode: steamUri[1].toLowerCase() === 'rungameid' ? 'game' : 'app', appId: steamUri[2], arguments: '' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return { type: 'url', target, arguments: '' };
  const steamArgs = /(?:^|\s)-applaunch\s+(\d+)(?:\s+([\s\S]*))?$/i.exec(args);
  if (/steam\.exe$/i.test(target) && steamArgs) return { type: 'steam', steamMode: 'app', appId: steamArgs[1], arguments: steamArgs[2] ?? '' };
  return { type: 'program', path: target, arguments: args, workingDirectory: text(shortcut?.cwd, 'Shortcut working directory', 1000) };
}

async function launchAction(rawAction, context, services) {
  const action = validateAction(rawAction);
  const argsText = interpolate(action.arguments, context);
  if (action.type === 'steam') {
    if (action.steamMode === 'game') {
      await services.openExternal(`steam://rungameid/${action.appId}`);
      return `Steam game ${action.appId}`;
    }
    let steamArguments = argsText;
    if (action.steamMode === 'source') {
      const modFolder = path.resolve(interpolate(action.sourceModPath, context));
      await fs.access(path.join(modFolder, 'GameInfo.txt')).catch(() => fs.access(path.join(modFolder, 'gameinfo.txt')));
      steamArguments = `-game "${modFolder}"${argsText ? ` ${argsText}` : ''}`;
    }
    const suffix = steamArguments ? `//${encodeURIComponent(steamArguments)}/` : '/';
    await services.openExternal(`steam://run/${action.appId}${suffix}`);
    return `Steam app ${action.appId}`;
  }
  if (action.type === 'url') {
    const target = interpolate(action.target, context);
    let url;
    try { url = new URL(target); } catch { throw new Error('The resolved launch URL is invalid.'); }
    if (!ALLOWED_URI_SCHEMES.has(url.protocol)) throw new Error(`The ${url.protocol} launch protocol is not allowed.`);
    await services.openExternal(url.toString());
    return target;
  }
  if (action.type === 'file') {
    const target = path.resolve(interpolate(action.target, context));
    await fs.access(target);
    const error = await services.openPath(target);
    if (error) throw new Error(error);
    return path.basename(target);
  }
  if (action.type === 'minecraft') {
    await fs.access(action.launcherPath);
    const profileDocument = JSON.parse(await fs.readFile(path.join(action.minecraftRoot, 'launcher_profiles.json'), 'utf8'));
    const installed = profileDocument.profiles?.[action.minecraftProfileId];
    if (!installed || String(installed.lastVersionId || '') !== action.minecraftVersion) {
      throw new Error(`Minecraft installation ${action.minecraftProfileName || action.minecraftProfileId} is missing or now points to a different version.`);
    }
    await fs.access(path.join(action.minecraftRoot, 'versions', action.minecraftVersion, `${action.minecraftVersion}.json`));
    const child = services.spawn(action.launcherPath, [], { cwd: path.dirname(action.launcherPath), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return `Minecraft Launcher opened · select ${action.minecraftProfileName || action.minecraftProfileId} and press Play`;
  }
  const executable = path.resolve(interpolate(action.path, context));
  await fs.access(executable);
  const cwdValue = interpolate(action.workingDirectory, context);
  const cwd = cwdValue ? path.resolve(cwdValue) : path.dirname(executable);
  await fs.access(cwd);
  const child = services.spawn(executable, splitArguments(argsText), { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return path.basename(executable);
}

async function launchProfile(rawProfile, context, services, requestedStage = 'all') {
  const profile = validateProfile(rawProfile);
  const stage = ['all', 'primary', 'companion'].includes(requestedStage) ? requestedStage : 'all';
  if (stage === 'companion' && !profile.companion) throw new Error('This launch profile has no companion action.');
  const launched = [];
  if (stage !== 'companion') launched.push(await launchAction(profile.primary, context, services));
  if (profile.companion && (stage === 'companion' || stage === 'all' && profile.companionMode === 'automatic')) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    launched.push(await launchAction(profile.companion, context, services));
  }
  return { profile, launched, deferred: Boolean(profile.companion && profile.companionMode === 'manual' && stage !== 'companion') };
}

module.exports = { ALLOWED_URI_SCHEMES, actionFromShortcut, interpolate, launchAction, launchProfile, splitArguments, validateAction, validateProfile };
