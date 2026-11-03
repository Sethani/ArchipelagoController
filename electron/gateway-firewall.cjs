const path = require('node:path');

const RULE_GROUP = 'Archipelago Controller Managed Gateway';
const MANAGED_GATEWAY_RULES = Object.freeze([
  { name: `${RULE_GROUP} HTTP v1`, port: 80 },
  { name: `${RULE_GROUP} HTTPS v1`, port: 443 },
  { name: `${RULE_GROUP} Compatibility v1`, port: 38281 },
]);

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function createProcessRunner(spawn) {
  return (executable, args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function installScript(rules = MANAGED_GATEWAY_RULES) {
  const entries = rules.map((rule) => `@{ Name = '${rule.name.replaceAll("'", "''")}'; Port = ${rule.port} }`).join(',\n  ');
  return `$ErrorActionPreference = 'Stop'
$netsh = Join-Path $env:SystemRoot 'System32\\netsh.exe'
$rules = @(
  ${entries}
)
foreach ($rule in $rules) {
  & $netsh advfirewall firewall delete rule "name=$($rule.Name)" | Out-Null
  & $netsh advfirewall firewall add rule "name=$($rule.Name)" dir=in action=allow protocol=TCP "localport=$($rule.Port)" profile=private,public enable=yes edge=no | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Windows Firewall rejected port $($rule.Port)." }
}`;
}

function elevationScript(innerEncoded, powershellPath) {
  const safePath = powershellPath.replaceAll("'", "''");
  return `$ErrorActionPreference = 'Stop'
try {
  $process = Start-Process -FilePath '${safePath}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${innerEncoded}')
  exit $process.ExitCode
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
}

function createGatewayFirewall({
  platform = process.platform,
  spawn,
  runCommand = spawn ? createProcessRunner(spawn) : undefined,
  systemRoot = process.env.SystemRoot || 'C:\\Windows',
  onLog = () => {},
} = {}) {
  if (!runCommand) throw new Error('A process runner is required.');
  const powershellPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  async function inspect() {
    if (platform !== 'win32') return { state: 'unused', missing: [] };
    const checks = await Promise.all(MANAGED_GATEWAY_RULES.map(async (rule) => {
      const result = await runCommand('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=${rule.name}`, 'verbose']);
      const output = `${result.stdout}\n${result.stderr}`.toLocaleLowerCase();
      return { ...rule, present: result.code === 0 && output.includes(rule.name.toLocaleLowerCase()) };
    }));
    const missing = checks.filter((rule) => !rule.present).map(({ name, port }) => ({ name, port }));
    return { state: missing.length ? 'required' : 'ready', missing };
  }

  async function ensure() {
    const before = await inspect();
    if (before.state === 'unused' || before.state === 'ready') return { ...before, changed: false };
    onLog(`Windows Firewall permission is required for managed room sharing (${before.missing.map((rule) => rule.port).join(', ')}).`);
    const inner = encodePowerShell(installScript());
    const outer = encodePowerShell(elevationScript(inner, powershellPath));
    const result = await runCommand(powershellPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', outer]);
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim();
      throw new Error(detail
        ? `Windows Firewall setup was not completed: ${detail.split(/\r?\n/).at(-1)}`
        : 'Windows Firewall setup was cancelled. Approve the Windows prompt to share this room publicly.');
    }
    const after = await inspect();
    if (after.missing.length) throw new Error(`Windows Firewall did not retain the required rule${after.missing.length === 1 ? '' : 's'} for port${after.missing.length === 1 ? '' : 's'} ${after.missing.map((rule) => rule.port).join(', ')}.`);
    onLog('Windows Firewall is ready for managed room sharing.');
    return { ...after, changed: true };
  }

  return { ensure, inspect };
}

module.exports = {
  MANAGED_GATEWAY_RULES,
  RULE_GROUP,
  createGatewayFirewall,
  elevationScript,
  encodePowerShell,
  installScript,
};
