import { describe, expect, it } from 'vitest';
import { migrateMainRelativeSettings, resolveMainPath, tokenizeMainPath } from './paths';
import { initialState } from './storage';

describe('installation-relative paths', () => {
  it('resolves the main token against the current installation', () => {
    expect(resolveMainPath('{main}\\Players\\Temp', 'D:\\Games\\Archipelago\\')).toBe('D:\\Games\\Archipelago\\Players\\Temp');
  });

  it('converts child paths case-insensitively without capturing similarly named folders', () => {
    expect(tokenizeMainPath('c:\\programdata\\ARCHIPELAGO\\output', 'C:\\ProgramData\\Archipelago')).toBe('{main}\\output');
    expect(tokenizeMainPath('C:\\ProgramData\\ArchipelagoBackup\\output', 'C:\\ProgramData\\Archipelago')).toBe('C:\\ProgramData\\ArchipelagoBackup\\output');
  });

  it('keeps external storage absolute during migration', () => {
    const settings = migrateMainRelativeSettings({
      ...initialState.settings,
      importSource: 'C:\\ProgramData\\Archipelago\\Players\\Temp',
      libraryPath: 'C:\\ProgramData\\Archipelago\\Players\\Library',
      outputRoot: 'C:\\ProgramData\\Archipelago\\output',
      hostedSessionsPath: 'C:\\games\\archipelago',
    });

    expect(settings.importSource).toBe('{main}\\Players\\Temp');
    expect(settings.libraryPath).toBe('{main}\\Players\\Library');
    expect(settings.outputRoot).toBe('{main}\\output');
    expect(settings.hostedSessionsPath).toBe('C:\\games\\archipelago');
  });
});
