import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const { extractHostComments, readHostConfig, validateHostDocument, writeHostConfig } = require('./host-config.cjs');

describe('host.yaml configuration', () => {
  it('extracts multiline field comments including comments attached to a section map', () => {
    const yamlDocument = YAML.parseDocument(`server_options:\n  # Release modes\n  # enabled -> clients can release\n  release_mode: auto\nstardew_valley_options:\n  # Allow players to pick Allsanity.\n  allow_allsanity: true\n`);
    expect(extractHostComments(yamlDocument)).toMatchObject({
      'server_options.release_mode': 'Release modes\nenabled -> clients can release',
      'stardew_valley_options.allow_allsanity': 'Allow players to pick Allsanity.',
    });
  });

  it('rejects unsafe or excessively nested documents', () => {
    expect(() => validateHostDocument({ constructor: { polluted: true } })).toThrow(/invalid option name/);
    let nested = {};
    for (let index = 0; index < 14; index += 1) nested = { next: nested };
    expect(() => validateHostDocument(nested)).toThrow(/too deep/);
  });

  it('sanitizes secrets for the renderer and preserves them during a guarded write', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-config-test-'));
    const source = {
      server_options: { port: 38281, password: 'room-secret', server_password: 'admin-secret', hint_cost: 10 },
      generator: { spoiler: 3 },
      stardew_valley_options: { allow_allsanity: true },
    };
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: [0, 6, 7] }));
    await fs.writeFile(path.join(root, 'host.yaml'), `# Controller should preserve this documentation\n${YAML.stringify(source)}`);
    try {
      const loaded = await readHostConfig(root);
      expect(loaded.document.server_options).toMatchObject({ password: null, server_password: null, hint_cost: 10 });
      loaded.document.server_options.hint_cost = 20;
      const written = await writeHostConfig({ installRoot: root, document: loaded.document });
      const saved = YAML.parse(await fs.readFile(path.join(root, 'host.yaml'), 'utf8'));
      expect(saved.server_options).toMatchObject({ password: 'room-secret', server_password: 'admin-secret', hint_cost: 20 });
      expect(saved.stardew_valley_options.allow_allsanity).toBe(true);
      expect(await fs.readFile(path.join(root, 'host.yaml'), 'utf8')).toContain('# Controller should preserve this documentation');
      expect(await fs.readFile(written.backupPath, 'utf8')).toContain('room-secret');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
