import { describe, expect, it } from 'vitest';
import { contentWithSlotName, exportedYamlName, gameCode, hostYaml, inspectYaml, normalizeLegacySlotName, prepareTemplates, suggestedFileName, yamlFingerprint } from './session';

const file = (name: string, content: string): PickedYaml => ({ name, content, path: `C:\\input\\${name}` });

describe('session preparation', () => {
  it('inspects valid YAML and suggests normalized filenames', () => {
    const template = inspectYaml(file('messy.yaml', 'name: Sethiduck\ngame: A Link to the Past\n'));
    expect(template.slotName).toBe('Sethiduck');
    expect(suggestedFileName(template)).toBe('ALinkToThePast_Imported.yaml');
  });

  it('renames duplicate slots only in prepared copies', () => {
    const first = inspectYaml(file('ALinkToThePast_Easy.yaml', 'name: Sethiduck\ngame: A Link to the Past\n'));
    const second = inspectYaml(file('SuperMetroid_Easy.yaml', 'name: Sethiduck\ngame: Super Metroid\n'));
    const prepared = prepareTemplates([first, second]);
    expect(prepared.map((item) => item.resolvedSlotName)).toEqual(['Sethiduck_ALTTP', 'Sethiduck_SM']);
    expect(first.content).toContain('name: Sethiduck');
    expect(prepared[0].preparedContent).toContain('name: Sethiduck_ALTTP');
  });

  it('adds a numeric suffix when duplicate games also collide', () => {
    const inputs = [1, 2].map((number) => inspectYaml(file(`SuperMetroid_${number}.yaml`, 'name: Samus\ngame: Super Metroid\n')));
    expect(prepareTemplates(inputs).map((item) => item.resolvedSlotName)).toEqual(['Samus_SM', 'Samus_SM2']);
    expect(gameCode('Super Metroid')).toBe('SM');
  });

  it('writes Archipelago server options in the expected host schema', () => {
    const output = hostYaml({ host: '', port: 38281, roomPasswordSet: false, serverPasswordSet: false, savefile: '', autoShutdown: 0, logLevel: 'info', raw: 'compatibility: 2', document: {}, comments: {} });
    expect(output).toContain('server_options:');
    expect(output).toContain('compatibility: 2');
    expect(output).toContain('port: 38281');
  });

  it('preserves parsed generator and world options while overriding managed server fields', () => {
    const output = hostYaml({
      host: 'localhost', port: 40000, roomPasswordSet: false, serverPasswordSet: false, savefile: '', autoShutdown: 60,
      logLevel: 'warning', raw: '', comments: {}, document: {
        server_options: { port: 38281, hint_cost: 20 },
        generator: { spoiler: 3 },
        stardew_valley_options: { allow_allsanity: true },
      },
    });
    expect(output).toContain('port: 40000');
    expect(output).toContain('hint_cost: 20');
    expect(output).toContain('spoiler: 3');
    expect(output).toContain('allow_allsanity: true');
  });

  it('removes legacy game suffixes from Temp player names', () => {
    expect(normalizeLegacySlotName('Sethiduck_ALTTP.yaml', 'C:\\ProgramData\\Archipelago\\Players\\Temp\\Sethiduck_ALTTP.yaml', 'Sethiduck_ALTTP')).toBe('Sethiduck');
    expect(normalizeLegacySlotName('Minecraft_Mine.yaml', 'C:\\ProgramData\\Archipelago\\Players\\ControllerLibrary\\Minecraft\\Minecraft_Mine.yaml', 'Sethiduck_Mine')).toBe('Sethiduck');
    expect(normalizeLegacySlotName('ALinkToThePast_Easy.yaml', 'C:\\Library\\ALinkToThePast_Easy.yaml', 'Sethiduck_ALTTP')).toBe('Sethiduck_ALTTP');
  });

  it('recognizes identical YAML across Windows and Unix line endings', () => {
    expect(yamlFingerprint('name: Sethiduck\r\ngame: VVVVVV\r\n')).toBe(yamlFingerprint('name: Sethiduck\ngame: VVVVVV\n'));
  });

  it('exports player loadouts without changing source YAML', () => {
    const template = inspectYaml(file('VVVVVV_Casual.yaml', 'name: Sethiduck\ngame: VVVVVV\n'));
    expect(exportedYamlName(template, 'Sethani')).toBe('VVVVVV_Sethani_Casual.yaml');
    expect(contentWithSlotName(template.content, 'Sethani')).toContain('name: Sethani');
    expect(template.content).toContain('name: Sethiduck');
  });
});
