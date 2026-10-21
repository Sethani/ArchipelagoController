const fs = require('node:fs/promises');
const path = require('node:path');

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateGatewayConfig(raw) {
  const hostname = String(raw?.hostname ?? '').trim().toLocaleLowerCase();
  const email = String(raw?.email ?? '').trim();
  const upstreamPort = Number(raw?.upstreamPort);
  const gamePort = Number(raw?.gamePort);
  if (!HOSTNAME_PATTERN.test(hostname)) throw new Error('Enter a public DNS hostname such as rooms.example.net.');
  if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new Error('Enter a valid certificate contact email.');
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error('The room portal port is invalid.');
  if (!Number.isInteger(gamePort) || gamePort < 1 || gamePort > 65535 || gamePort === upstreamPort) throw new Error('The Archipelago game port is invalid.');
  return { hostname, email, upstreamPort, gamePort };
}

function caddyfile(config) {
  const { hostname, email, upstreamPort, gamePort } = validateGatewayConfig(config);
  return `{
\tadmin off
\temail ${email}
}

${hostname} {
\troute {
\t\t@archipelago_websocket header Upgrade websocket
\t\treverse_proxy @archipelago_websocket 127.0.0.1:${gamePort}
\t\treverse_proxy 127.0.0.1:${upstreamPort}
\t}
\theader {
\t\tX-Content-Type-Options nosniff
\t\tReferrer-Policy no-referrer
\t}
}
`;
}

function bundledExecutable(isPackaged, resourcesPath, moduleDirectory) {
  return isPackaged
    ? path.join(resourcesPath, 'caddy', 'caddy.exe')
    : path.join(moduleDirectory, '..', 'vendor', 'caddy', 'caddy.exe');
}

function createHttpsGateway({ app, spawn, onStatus = () => {}, onLog = () => {} }) {
  let child;
  let current;
  let certificateTimer;

  async function stop() {
    if (certificateTimer) clearInterval(certificateTimer);
    certificateTimer = undefined;
    const running = child;
    child = undefined;
    current = undefined;
    if (!running || running.exitCode !== null) return;
    running.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1800);
      running.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (running.exitCode === null) running.kill('SIGKILL');
  }

  async function start(raw) {
    await stop();
    const config = validateGatewayConfig(raw);
    const executable = bundledExecutable(app.isPackaged, process.resourcesPath, __dirname);
    await fs.access(executable).catch(() => { throw new Error('The managed HTTPS component is missing. Reinstall Controller or use an external HTTPS proxy.'); });
    const root = path.join(app.getPath('userData'), 'https-gateway');
    const configPath = path.join(root, 'Caddyfile');
    const dataPath = path.join(root, 'data');
    const configHome = path.join(root, 'config');
    await fs.mkdir(dataPath, { recursive: true });
    await fs.mkdir(configHome, { recursive: true });
    await fs.writeFile(configPath, caddyfile(config), { encoding: 'utf8', mode: 0o600 });
    onStatus({ gateway: 'starting', certificate: 'obtaining' });
    const next = spawn(executable, ['run', '--config', configPath, '--adapter', 'caddyfile'], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, XDG_DATA_HOME: dataPath, XDG_CONFIG_HOME: configHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = next;
    current = config;
    let settled = false;
    let earlyError;
    const consume = (chunk, level) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        onLog(line, level);
        if (/certificate obtained successfully|served certificate|finished cleaning storage units/i.test(line)) onStatus({ gateway: 'online', certificate: 'ready' });
        if (/obtaining certificate|acme_client|authorization/i.test(line)) onStatus({ gateway: 'online', certificate: 'obtaining' });
        if (/"level":"error"/i.test(line) && /certificate|acme|challenge|tls\.obtain/i.test(line)) onStatus({ gateway: 'online', certificate: 'error', gatewayError: 'Certificate issuance failed. See Activity for the gateway response.' });
      }
    };
    next.stdout.on('data', (chunk) => consume(chunk, 'info'));
    next.stderr.on('data', (chunk) => consume(chunk, 'info'));
    next.once('error', (error) => { earlyError = error; onStatus({ gateway: 'error', certificate: 'error', gatewayError: error.message }); });
    next.once('close', (code) => {
      if (child === next) { child = undefined; current = undefined; }
      if (!settled || code) onStatus({ gateway: 'error', certificate: 'error', gatewayError: `Managed HTTPS stopped with exit code ${code ?? 'unknown'}.` });
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    settled = true;
    if (earlyError) throw earlyError;
    if (next.exitCode !== null) throw new Error(`Managed HTTPS stopped during startup with exit code ${next.exitCode}. Ports 80 or 443 may already be in use.`);
    const inspectCertificate = async () => {
      try {
        const certificateRoot = path.join(dataPath, 'caddy', 'certificates');
        const files = await fs.readdir(certificateRoot, { recursive: true });
        if (files.some((file) => path.basename(String(file)).toLocaleLowerCase() === `${config.hostname}.crt`)) {
          onStatus({ gateway: 'online', certificate: 'ready', gatewayError: undefined });
          if (certificateTimer) clearInterval(certificateTimer);
          certificateTimer = undefined;
          return true;
        }
      } catch { /* Certificate storage appears after the first successful ACME order. */ }
      return false;
    };
    const certificateReady = await inspectCertificate();
    if (!certificateReady) {
      certificateTimer = setInterval(() => void inspectCertificate(), 2000);
      certificateTimer.unref?.();
    }
    onStatus({ gateway: 'online' });
    return { hostname: config.hostname, publicBaseUrl: `https://${config.hostname}`, pid: next.pid };
  }

  return {
    start,
    stop,
    get running() { return Boolean(child && child.exitCode === null); },
    get status() { return current ? { hostname: current.hostname, running: Boolean(child && child.exitCode === null), pid: child?.pid } : { running: false }; },
  };
}

module.exports = { HOSTNAME_PATTERN, bundledExecutable, caddyfile, createHttpsGateway, validateGatewayConfig };
