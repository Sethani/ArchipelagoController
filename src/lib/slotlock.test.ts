import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { Player, Template } from '../types';
import { inspectYaml, prepareTemplates } from './session';
import {
  buildSlotLockTargetGroups,
  createSlotLockConfig,
  createSlotLockYaml,
  hydrateSlotLockOptions,
  slotLockConfigErrors,
  slotLockSessionFingerprint,
  uniqueControllerSlotName,
} from './slotlock';

const player: Player = { id: 'seth', name: 'Sethiduck', preferredSlot: 'Sethani', note: '' };
const template = (game: string, id: string): Template => ({
  ...inspectYaml({ name: `${game}.yaml`, path: `C:\templates\${game}.yaml`, content: `name: Sethani\ngame: ${game}\n` }),
  id,
  game,
  playerId: player.id,
  errors: [],
});

describe('roster-driven SlotLock', () => {
  it('groups only non-SlotLock prepared slots by roster owner', () => {
    const prepared = prepareTemplates([template('Minecraft', 'minecraft'), template('Stardew Valley', 'stardew'), template('SlotLock', 'manual')]);
    const groups = buildSlotLockTargetGroups(prepared, [player]);
    expect(groups).toHaveLength(1);
    expect(groups[0].templates.map((item) => item.game)).toEqual(['Minecraft', 'Stardew Valley']);
  });

  it('creates a unique controller name within the 16 character limit', () => {
    const first = uniqueControllerSlotName('An Extremely Long Player', []);
    const second = uniqueControllerSlotName('An Extremely Long Player', [first]);
    expect(first.length).toBeLessThanOrEqual(16);
    expect(second.length).toBeLessThanOrEqual(16);
    expect(second).not.toBe(first);
  });

  it('generates automatic YAML from resolved working-copy names', () => {
    const prepared = prepareTemplates([template('Minecraft', 'minecraft'), template('Stardew Valley', 'stardew')]);
    const config = createSlotLockConfig(player, prepared.map((item) => item.resolvedSlotName));
    const parsed = parse(createSlotLockYaml(config, prepared)) as Record<string, any>;
    expect(parsed.name).toBe('Sethani_Locks');
    expect(parsed.game).toBe('SlotLock');
    expect(parsed.SlotLock.slots_to_lock).toEqual(prepared.map((item) => item.resolvedSlotName));
    expect(parsed.SlotLock.slots_whitelist).toBe(true);
  });

  it('preserves comments and uncommon source options while replacing owned fields', () => {
    const source = template('SlotLock', 'source');
    source.content = '# controller source\nname: Old\ngame: SlotLock\nSlotLock:\n  # uncommon setting\n  progression_balancing: 25\n  slots_to_lock: [OldSlot]\n  random_unlocked_slots: 0\n';
    const prepared = prepareTemplates([template('Minecraft', 'minecraft')]);
    const config = { ...createSlotLockConfig(player, []), options: { ...hydrateSlotLockOptions(source.content), randomUnlockedSlots: 1 } };
    const output = createSlotLockYaml(config, prepared, source);
    expect(output).toContain('# controller source');
    expect(output).toContain('# uncommon setting');
    expect(output).toContain('progression_balancing: 25');
    expect((parse(output) as Record<string, any>).SlotLock.slots_to_lock).toEqual(['Sethani']);
  });

  it('rejects impossible starting unlocks and empty target sets', () => {
    const config = createSlotLockConfig(player, []);
    config.options.randomUnlockedSlots = 2;
    expect(slotLockConfigErrors(config, [], [])).toEqual(expect.arrayContaining([
      'At least one player game must be included',
      'Random starting unlocks cannot exceed included games',
    ]));
  });

  it('invalidates the complete-session fingerprint when exclusions or contents change', () => {
    const config = createSlotLockConfig(player, []);
    const base = slotLockSessionFingerprint([{ preparedContent: 'name: One' }], [config], 'world-a');
    const excluded = slotLockSessionFingerprint([{ preparedContent: 'name: One' }], [{ ...config, excludedTemplateIds: ['one'] }], 'world-a');
    const changed = slotLockSessionFingerprint([{ preparedContent: 'name: Two' }], [config], 'world-a');
    expect(excluded).not.toBe(base);
    expect(changed).not.toBe(base);
  });
});
