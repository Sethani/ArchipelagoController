import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { classifyFailure, createYamlValidator, readGame, sanitizeOutput, schemaError, slotLockContextIssue, slotLockOptionIssue, validateRequest, yamlFingerprint } = require('./yaml-validation.cjs');

const match = (status = 'Installed') => ({ game: 'Example', status, signature: 'custom:example:abc', candidates: [], message: `${status} world` });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yaml-validation-test-'));
  await fs.writeFile(path.join(root, 'ArchipelagoGenerate.exe'), 'fixture');
  return root;
}

describe('YAML validation parsing', () => {
  it('extracts exact game names and rejects malformed roots', () => {
    expect(readGame('name: Player\ngame: Example\n')).toMatchObject({ game: 'Example' });
    expect(readGame('- game: Example\n').error).toMatch(/mapping/);
    expect(readGame('name: Player\n').error).toMatch(/game name/);
  });

  it('rejects unknown top-level and generated-template option keys', () => {
    const schemas = new Map([['example', { topLevel: new Set(['name', 'game', 'Example']), options: new Set(['difficulty']) }]]);
    expect(schemaError(readGame('name: Player\ngame: Example\nunknown: true\n'), schemas)).toMatch(/Unknown top-level/);
    expect(schemaError(readGame('name: Player\ngame: Example\nExample:\n  difficulty: hard\n  typo: true\n'), schemas)).toMatch(/Unknown Example option/);
    expect(schemaError(readGame('name: Player\ngame: Example\nExample:\n  difficulty: hard\n'), schemas)).toBeNull();
  });

  it('recognizes option rejection separately from generation failures', () => {
    expect(classifyFailure('OptionError: difficulty is not a valid choice')).toBe('Rejected');
    expect(classifyFailure('RuntimeError: fill could not place progression')).toBe('Generator failed');
  });

  it('redacts paths, passwords, terminal color, and normalizes fingerprints', () => {
    const output = sanitizeOutput('C:\\Temp\\run\nserver_password: secret\n\x1b[31mBad\x1b[0m', 'C:\\Temp\\run', 'C:\\AP');
    expect(output).toContain('<validation>');
    expect(output).toContain('server_password: <redacted>');
    expect(output).not.toContain('\x1b');
    expect(yamlFingerprint('game: Example\r\n')).toBe(yamlFingerprint('game: Example\n'));
  });

  it('bounds validation requests', () => {
    expect(() => validateRequest({ installRoot: 'C:\\AP', templates: [] })).toThrow(/between 1 and 200/);
    expect(() => validateRequest({ installRoot: 'C:\\AP', templates: [{ id: 'x', content: '' }] })).toThrow(/empty/);
  });

  it('checks SlotLock references against the prepared session roster', () => {
    const slotLock = { parsed: readGame("name: Locks\ngame: SlotLock\nSlotLock:\n  slots_to_lock: [Player One, Missing]\n") };
    const player = { parsed: readGame('name: Player One\ngame: Example\n') };
    expect(slotLockContextIssue(slotLock, [slotLock, player]).message).toMatch(/Missing/);
    expect(slotLockContextIssue(slotLock, [slotLock, { parsed: readGame('name: Missing\ngame: Example\n') }, player])).toBeNull();
  });

  it('checks deterministic SlotLock option invariants before generation', () => {
    expect(slotLockOptionIssue(readGame('name: Locks\ngame: SlotLock\nSlotLock:\n  bonus_item_copies: 0\n'))).toMatch(/1 to 10/);
    expect(slotLockOptionIssue(readGame('name: Locks\ngame: SlotLock\nSlotLock:\n  bonus_item_copies: 1\n  slots_to_lock: [Player One]\n'))).toBeNull();
  });
});

describe('YAML validation queue', () => {
  it('runs sequentially and preserves per-template outcomes', async () => {
    const installRoot = await fixture();
    const calls = [];
    const progress = [];
    const validator = createYamlValidator({
      resolveGames: async ({ games }) => games.map(() => match()),
      run: async (_command, args) => {
        calls.push(args);
        return calls.length === 1
          ? { exitCode: 0, output: 'Generation complete', durationMs: 12 }
          : { exitCode: 1, output: 'OptionError: invalid choice', durationMs: 10 };
      },
    });
    const sender = { isDestroyed: () => false, send: (_channel, value) => progress.push(value) };
    try {
      const response = await validator.validate({ installRoot, templates: [
        { id: 'one', fileName: 'one.yaml', content: 'name: One\ngame: Example\n' },
        { id: 'two', fileName: 'two.yaml', content: 'name: Two\ngame: Example\n' },
      ] }, sender);
      expect(response.results.map((item) => item.result.status)).toEqual(['Valid', 'Rejected']);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('--skip_output');
      expect(progress.filter((item) => item.state === 'complete')).toHaveLength(2);
    } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
  });

  it('rejects missing worlds without starting Archipelago', async () => {
    const installRoot = await fixture();
    let calls = 0;
    const validator = createYamlValidator({ resolveGames: async () => [match('Missing')], run: async () => { calls += 1; } });
    try {
      const response = await validator.validate({ installRoot, templates: [{ id: 'one', fileName: 'one.yaml', content: 'name: One\ngame: Example\n' }] }, null);
      expect(response.results[0].result.status).toBe('Rejected');
      expect(calls).toBe(0);
    } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
  });

  it('lets the generator decide options when a custom world overrides a bundled provider', async () => {
    const installRoot = await fixture();
    await fs.mkdir(path.join(installRoot, 'Players', 'Templates'), { recursive: true });
    await fs.writeFile(path.join(installRoot, 'Players', 'Templates', 'Example.yaml'), 'name: Player\ngame: Example\nExample:\n  difficulty: normal\n');
    let calls = 0;
    const validator = createYamlValidator({
      resolveGames: async () => [match('Installed with override')],
      run: async () => { calls += 1; return { exitCode: 0, output: 'Accepted custom option', durationMs: 8 }; },
    });
    try {
      const response = await validator.validate({ installRoot, templates: [{ id: 'one', fileName: 'one.yaml', content: 'name: One\ngame: Example\nExample:\n  custom_option: true\n' }] }, null);
      expect(response.results[0].result.status).toBe('Valid');
      expect(calls).toBe(1);
    } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
  });

  it('marks standalone SlotLock checks as needing session context after option parsing succeeds', async () => {
    const installRoot = await fixture();
    const validator = createYamlValidator({
      resolveGames: async () => [match()],
      run: async () => ({ exitCode: 0, output: 'Standalone generation succeeded', durationMs: 4 }),
    });
    try {
      const response = await validator.validate({ installRoot, templates: [{ id: 'locks', fileName: 'locks.yaml', content: 'name: Locks\ngame: SlotLock\nSlotLock:\n  slots_to_lock: [Player One]\n' }] }, null);
      expect(response.results[0].result.status).toBe('Context required');
    } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
  });

  it('does not let a SlotLock context error hide a concrete option error', async () => {
    const installRoot = await fixture();
    const validator = createYamlValidator({
      resolveGames: async () => [match()],
      run: async () => ({ exitCode: 1, output: 'OptionError: 0 is lower than minimum 1\nRuntimeError: Too many random unlocked slots.', durationMs: 4 }),
    });
    try {
      const response = await validator.validate({ installRoot, templates: [{ id: 'locks', fileName: 'locks.yaml', content: 'name: Locks\ngame: SlotLock\nSlotLock:\n  bonus_item_copies: 0\n  random_unlocked_slots: 1\n' }] }, null);
      expect(response.results[0].result.status).toBe('Rejected');
      expect(response.results[0].result.message).toMatch(/1 to 10/);
    } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
  });

  it('validates SlotLock with all prepared session YAMLs in one generator run', async () => {
    const installRoot = await fixture();
    const calls = [];
    const validator = createYamlValidator({
      resolveGames: async ({ games }) => games.map(() => match()),
      run: async (_command, args) => { calls.push(args); return { exitCode: 0, output: 'Session accepted', durationMs: 5 }; },
    });
    try {
      const response = await validator.validate({ installRoot, sessionContext: true, templates: [
        { id: 'locks', fileName: 'locks.yaml', content: 'name: Locks\ngame: SlotLock\nSlotLock:\n  slots_to_lock: [Player One]\n', sourceFingerprint: 'a'.repeat(16) },
        { id: 'one', fileName: 'one.yaml', content: 'name: Player One\ngame: Example\n' },
      ] }, null);
      expect(response.results[0].result).toMatchObject({ status: 'Valid', fingerprint: 'a'.repeat(16) });
      expect(response.results[0].result.contextFingerprint).toMatch(/^[a-f0-9]{16}$/);
      expect(calls[0].slice(calls[0].indexOf('--multi'), calls[0].indexOf('--multi') + 2)).toEqual(['--multi', '2']);
    } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
  });

  it('reports generator timeouts distinctly', async () => {
    const installRoot = await fixture();
    const validator = createYamlValidator({
      resolveGames: async () => [match()],
      run: async () => ({ exitCode: null, output: 'still working', durationMs: 120000, timedOut: true }),
    });
    try {
      const response = await validator.validate({ installRoot, templates: [{ id: 'one', fileName: 'one.yaml', content: 'name: One\ngame: Example\n' }] }, null);
      expect(response.results[0].result.status).toBe('Timed out');
    } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
  });

  it('cancels the active process and marks the result', async () => {
    const installRoot = await fixture();
    const validator = createYamlValidator({
      resolveGames: async () => [match()],
      run: async (_command, _args, _cwd, state) => new Promise((resolve) => {
        state.current = { exitCode: null, kill: () => resolve({ exitCode: null, output: '', durationMs: 5, cancelled: true }) };
      }),
    });
    try {
      const pending = validator.validate({ installRoot, templates: [{ id: 'one', fileName: 'one.yaml', content: 'name: One\ngame: Example\n' }] }, null);
      while (!validator.isRunning()) await new Promise((resolve) => setTimeout(resolve, 1));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(validator.cancel().cancelled).toBe(true);
      const response = await pending;
      expect(response.results[0].result.status).toBe('Cancelled');
    } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
  });
});
