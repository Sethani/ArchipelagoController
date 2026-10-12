const fs = require('node:fs/promises');
const path = require('node:path');
const { compareVersions } = require('./apworlds.cjs');

const LATEST_RELEASE_URL = 'https://api.github.com/repos/ArchipelagoMW/Archipelago/releases/latest';
const RELEASES_URL = 'https://github.com/ArchipelagoMW/Archipelago/releases/latest';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function readInstalledVersion(installRoot) {
  if (!String(installRoot ?? '').trim()) return undefined;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(installRoot, 'manifest.json'), 'utf8'));
    const value = manifest.version ?? manifest.archipelago_version;
    return Array.isArray(value) ? value.join('.') : value ? String(value) : undefined;
  } catch { return undefined; }
}

function normalizeRelease(payload) {
  const version = String(payload?.tag_name ?? payload?.name ?? '').trim().replace(/^v/i, '');
  if (!version || payload?.draft || payload?.prerelease) throw new Error('GitHub did not return a stable Archipelago release.');
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const installer = assets.find((asset) => /^Setup[._ ]Archipelago[._ ].*\.exe$/i.test(String(asset?.name ?? '')))
    ?? assets.find((asset) => /Archipelago.*Setup.*\.exe$/i.test(String(asset?.name ?? '')));
  return {
    version,
    releaseUrl: String(payload.html_url || RELEASES_URL),
    installerUrl: installer?.browser_download_url ? String(installer.browser_download_url) : undefined,
    installerName: installer?.name ? String(installer.name) : undefined,
    publishedAt: payload.published_at ? String(payload.published_at) : undefined,
  };
}

function updateState(installedVersion, release, extra = {}) {
  if (!installedVersion) return { state: 'unknown', releaseUrl: RELEASES_URL, ...release, ...extra, error: 'Choose a valid Archipelago installation folder.' };
  if (!release?.version) return { state: 'unknown', installedVersion, releaseUrl: RELEASES_URL, ...extra };
  const order = compareVersions(installedVersion, release.version);
  return { state: order < 0 ? 'outdated' : order > 0 ? 'ahead' : 'current', installedVersion, latestVersion: release.version, ...release, ...extra };
}

function createApUpdateService({ app, net, maxAgeMs = CACHE_MAX_AGE_MS }) {
  const cacheFile = () => path.join(app.getPath('userData'), 'archipelago-release.json');
  let activeCheck = null;

  async function readCache() {
    try { return JSON.parse(await fs.readFile(cacheFile(), 'utf8')); } catch { return {}; }
  }

  async function writeCache(value) {
    await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
    await fs.writeFile(cacheFile(), JSON.stringify(value), 'utf8');
  }

  async function fetchRelease() {
    const response = await net.fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ArchipelagoController/0.1', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub release check failed with HTTP ${response.status}.`);
    return normalizeRelease(await response.json());
  }

  async function check({ installRoot, force = false } = {}) {
    const installedVersion = await readInstalledVersion(installRoot);
    if (!installedVersion) return updateState(undefined);
    const cached = await readCache();
    const cacheAge = cached.checkedAt ? Date.now() - new Date(cached.checkedAt).getTime() : Number.POSITIVE_INFINITY;
    if (!force && cached.release?.version && cacheAge < maxAgeMs) return updateState(installedVersion, cached.release, { checkedAt: cached.checkedAt, stale: false });
    if (activeCheck) return activeCheck.then((result) => updateState(installedVersion, result.release, result.extra));
    activeCheck = (async () => {
      try {
        const release = await fetchRelease();
        const checkedAt = new Date().toISOString();
        await writeCache({ release, checkedAt });
        return { release, extra: { checkedAt, stale: false } };
      } catch (error) {
        return {
          release: cached.release,
          extra: { checkedAt: cached.checkedAt, stale: true, error: error instanceof Error ? error.message : String(error) },
        };
      }
    })().finally(() => { activeCheck = null; });
    const result = await activeCheck;
    return updateState(installedVersion, result.release, result.extra);
  }

  return { check };
}

module.exports = { createApUpdateService, normalizeRelease, readInstalledVersion, updateState };
