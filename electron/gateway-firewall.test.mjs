import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MANAGED_GATEWAY_RULES, createGatewayFirewall, elevationScript, encodePowerShell, installScript } = require('./gateway-firewall.cjs');

describe('managed gateway firewall', () => {
  it('defines stable, port-scoped rules for both gateway transports', () => {
    const script = installScript();
    expect(MANAGED_GATEWAY_RULES.map((rule) => rule.port)).toEqual([80, 443, 38281]);
    expect(script).toContain('protocol=TCP');
    expect(script).toContain('profile=private,public');
    expect(script).not.toContain('Program');
  });

  it('wraps installation in a visible Windows elevation request', () => {
    const encoded = encodePowerShell('Write-Output ready');
    const script = elevationScript(encoded, 'C:\\Windows\\powershell.exe');
    expect(script).toContain('-Verb RunAs');
    expect(script).toContain('-WindowStyle Hidden');
    expect(script).toContain(encoded);
  });

  it('does not elevate when all durable rules already exist', async () => {
    const runCommand = vi.fn(async (_executable, args) => ({ code: 0, stdout: `Rule Name: ${String(args[4]).slice(5)}`, stderr: '' }));
    const manager = createGatewayFirewall({ platform: 'win32', runCommand });
    await expect(manager.ensure()).resolves.toMatchObject({ state: 'ready', changed: false });
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it('elevates once, then verifies every installed rule', async () => {
    let installed = false;
    const runCommand = vi.fn(async (executable, args) => {
      if (String(executable).toLocaleLowerCase().endsWith('powershell.exe')) {
        installed = true;
        return { code: 0, stdout: '', stderr: '' };
      }
      const name = String(args[4]).slice(5);
      return { code: 0, stdout: installed ? `Rule Name: ${name}` : 'No rules match the specified criteria.', stderr: '' };
    });
    const manager = createGatewayFirewall({ platform: 'win32', runCommand });
    await expect(manager.ensure()).resolves.toMatchObject({ state: 'ready', changed: true });
    expect(runCommand).toHaveBeenCalledTimes(7);
  });

  it('reports a cancelled elevation without pretending sharing is ready', async () => {
    const runCommand = vi.fn(async (executable) => String(executable).toLocaleLowerCase().endsWith('powershell.exe')
      ? { code: 1, stdout: '', stderr: '' }
      : { code: 0, stdout: 'No rules match the specified criteria.', stderr: '' });
    const manager = createGatewayFirewall({ platform: 'win32', runCommand });
    await expect(manager.ensure()).rejects.toThrow('Windows Firewall setup was cancelled');
  });
});
