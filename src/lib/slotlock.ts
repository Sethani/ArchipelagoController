import { parse, parseDocument, stringify } from 'yaml';
import type { ApWorldMatchResult, Player, SlotLockControllerConfig, SlotLockOptions, Template } from '../types';
import type { PreparedTemplate } from './session';
import { validationFingerprint } from './session';

export const defaultSlotLockOptions: SlotLockOptions = {
  randomUnlockedSlots: 1,
  freeStartingItems: false,
  unlockItemCopies: 1,
  unlockItemFiller: 0,
  freeUnlockedWorldItems: 0,
  bonusItemSlots: 0,
  bonusItemCopies: 1,
  bonusItemFiller: 0,
  autoHintLockedItems: false,
};

const OPTION_FIELDS: Array<[keyof SlotLockOptions, string]> = [
  ['randomUnlockedSlots', 'random_unlocked_slots'],
  ['freeStartingItems', 'free_starting_items'],
  ['unlockItemCopies', 'unlock_item_copies'],
  ['unlockItemFiller', 'unlock_item_filler'],
  ['freeUnlockedWorldItems', 'free_unlocked_world_items'],
  ['bonusItemSlots', 'bonus_item_slots'],
  ['bonusItemCopies', 'bonus_item_copies'],
  ['bonusItemFiller', 'bonus_item_filler'],
  ['autoHintLockedItems', 'auto_hint_locked_items'],
];

export type SlotLockTargetGroup = {
  player: Player;
  templates: PreparedTemplate[];
};

function cleanSlotName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_ -]+/g, '').replace(/\s+/g, '_') || 'Player';
}

export function uniqueControllerSlotName(playerName: string, usedNames: Iterable<string>): string {
  const used = new Set([...usedNames].map((name) => name.toLocaleLowerCase()));
  const desired = `${cleanSlotName(playerName)}_Locks`;
  let candidate = desired.slice(0, 16);
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const ending = `_${suffix++}`;
    candidate = `${desired.slice(0, 16 - ending.length)}${ending}`;
  }
  return candidate;
}

export function createSlotLockConfig(player: Player, usedNames: Iterable<string>): SlotLockControllerConfig {
  return {
    playerId: player.id,
    enabled: true,
    slotName: uniqueControllerSlotName(player.preferredSlot || player.name, usedNames),
    excludedTemplateIds: [],
    options: { ...defaultSlotLockOptions },
  };
}

export function buildSlotLockTargetGroups(prepared: PreparedTemplate[], players: Player[]): SlotLockTargetGroup[] {
  return players.map((player) => ({
    player,
    templates: prepared.filter((template) => template.playerId === player.id && template.game.trim().toLocaleLowerCase() !== 'slotlock'),
  })).filter((group) => group.templates.length > 0);
}

export function hydrateSlotLockOptions(content: string): SlotLockOptions {
  const next = { ...defaultSlotLockOptions };
  try {
    const parsed = parse(content) as Record<string, unknown>;
    const options = parsed?.SlotLock;
    if (!options || typeof options !== 'object' || Array.isArray(options)) return next;
    const record = options as Record<string, unknown>;
    for (const [field, yamlKey] of OPTION_FIELDS) {
      const value = record[yamlKey];
      if (typeof value === typeof next[field]) (next as Record<string, unknown>)[field] = value;
    }
  } catch { /* malformed sources remain visible and use safe defaults */ }
  return next;
}

export function slotLockConfigErrors(config: SlotLockControllerConfig, targets: PreparedTemplate[], allSlotNames: string[]): string[] {
  const errors: string[] = [];
  if (!config.slotName.trim()) errors.push('Controller slot name is required');
  if (config.slotName.length > 16) errors.push('Controller slot name must be 16 characters or fewer');
  if (allSlotNames.some((name) => name.toLocaleLowerCase() === config.slotName.trim().toLocaleLowerCase())) errors.push('Controller slot name conflicts with another session slot');
  if (!targets.length) errors.push('At least one player game must be included');
  const ranges: Array<[keyof SlotLockOptions, number, number, string]> = [
    ['randomUnlockedSlots', 0, 100, 'Random starting unlocks'],
    ['unlockItemCopies', 1, 10, 'Unlock copies'],
    ['unlockItemFiller', 0, 9, 'Unlock filler'],
    ['freeUnlockedWorldItems', 0, 10, 'Free unlocked-world items'],
    ['bonusItemSlots', 0, 1000, 'Bonus slots'],
    ['bonusItemCopies', 1, 10, 'Bonus copies'],
    ['bonusItemFiller', 0, 9, 'Bonus filler'],
  ];
  for (const [field, minimum, maximum, label] of ranges) {
    const value = config.options[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) errors.push(`${label} must be ${minimum}-${maximum}`);
  }
  if (config.options.randomUnlockedSlots > targets.length) errors.push('Random starting unlocks cannot exceed included games');
  if (!config.options.freeStartingItems && config.options.randomUnlockedSlots === 0 && targets.length > 0) errors.push('Enable a free start policy or at least one random starting unlock');
  return errors;
}

export function createSlotLockYaml(config: SlotLockControllerConfig, targets: PreparedTemplate[], source?: Template): string {
  const values: Record<string, unknown> = {
    slots_to_lock: targets.map((template) => template.resolvedSlotName),
    slots_whitelist: true,
    unlock_item_copies: config.options.unlockItemCopies,
    unlock_item_filler: config.options.unlockItemFiller,
    bonus_item_slots: config.options.bonusItemSlots,
    bonus_item_copies: config.options.bonusItemCopies,
    bonus_item_filler: config.options.bonusItemFiller,
    free_starting_items: config.options.freeStartingItems,
    free_unlocked_world_items: config.options.freeUnlockedWorldItems,
    random_unlocked_slots: config.options.randomUnlockedSlots,
    auto_hint_locked_items: config.options.autoHintLockedItems,
  };
  if (!source) {
    return stringify({
      name: config.slotName,
      description: 'Generated by Archipelago Controller.',
      game: 'SlotLock',
      SlotLock: {
        progression_balancing: 'normal',
        accessibility: 'full',
        ...values,
        local_items: [],
        non_local_items: [],
        start_inventory: {},
        start_hints: [],
        start_location_hints: [],
        exclude_locations: [],
        priority_locations: [],
      },
    });
  }

  const document = parseDocument(source.content);
  if (document.errors.length) return createSlotLockYaml(config, targets);
  const currentRoot = document.toJS();
  if (!currentRoot || typeof currentRoot !== 'object' || Array.isArray(currentRoot)) return createSlotLockYaml(config, targets);
  document.set('name', config.slotName);
  document.set('game', 'SlotLock');
  const root = document.toJS() as Record<string, unknown>;
  if (!root.SlotLock || typeof root.SlotLock !== 'object' || Array.isArray(root.SlotLock)) document.set('SlotLock', {});
  Object.entries(values).forEach(([key, value]) => document.setIn(['SlotLock', key], value));
  return document.toString();
}

export function createSlotLockTemplate(
  config: SlotLockControllerConfig,
  targets: PreparedTemplate[],
  source: Template | undefined,
  worldMatch: ApWorldMatchResult | undefined,
  allSlotNames: string[],
): Template {
  const content = createSlotLockYaml(config, targets, source);
  return {
    id: `slotlock-controller:${config.playerId}`,
    fileName: `SlotLock_${config.slotName}.yaml`,
    path: source?.path ?? `generated:${config.playerId}`,
    sourcePath: source?.sourcePath,
    content,
    game: 'SlotLock',
    description: source ? `Managed from ${source.description}` : 'Automatic controller',
    slotName: config.slotName,
    importedAt: new Date(0).toISOString(),
    errors: [
      ...slotLockConfigErrors(config, targets, allSlotNames),
      ...(config.sourceTemplateId && !source ? ['Selected SlotLock source template is missing'] : []),
      ...(source?.errors ?? []),
    ],
    playerId: config.playerId,
    worldMatch: worldMatch ?? source?.worldMatch,
    apValidation: config.apValidation,
  };
}

export function slotLockSessionFingerprint(templates: Array<{ preparedContent: string }>, configs: SlotLockControllerConfig[], worldSignature = ''): string {
  const configuration = configs.filter((config) => config.enabled).map((config) => ({
    ...config,
    apValidation: undefined,
    excludedTemplateIds: [...config.excludedTemplateIds].sort(),
  }));
  return validationFingerprint(JSON.stringify({ contents: templates.map((template) => template.preparedContent), configuration, worldSignature }));
}
