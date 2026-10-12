const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const YAML = require('yaml');

const MAX_TEMPLATES = 200;
const MAX_YAML_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 512 * 1024;
const VALIDATION_TIMEOUT_MS = 120 * 1000;

function yamlFingerprint(content) {
  const normalized = String(content).replace(/\r\n/g, '\n').trim();
  let hash = 14695981039346656037n;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= BigInt(normalized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
}

function sanitizeOutput(output, tempRoot, installRoot) {
  let sanitized = String(output)
    .replaceAll(tempRoot, '<validation>')
    .replaceAll(installRoot, '<Archipelago>')
    .replace(/((?:server_)?password\s*[:=]\s*)([^\s,}\]]+)/gi, '$1<redacted>')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n');
  if (sanitized.length > MAX_OUTPUT_CHARS) sanitized = `${sanitized.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
  return sanitized.trim();
}

function classifyFailure(output) {
  return /OptionError|is not a valid (?:option|choice|value)|unknown (?:option|game)|could not find (?:game|world)|no game (?:named|called)|failed to (?:parse|read).+ya?ml|yaml.+(?:invalid|error)|weights file.+(?:invalid|error)/i.test(output)
    ? 'Rejected'
    : 'Generator failed';
}

function resultMessage(status, output, fallback) {
  if (status === 'Valid') return 'Archipelago accepted this YAML.';
  if (status === 'Context required') return 'SlotLock needs the selected session roster for authoritative validation.';
  if (status === 'Timed out') return 'Archipelago validation exceeded 120 seconds.';
  if (status === 'Cancelled') return 'Validation was cancelled.';
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^press enter to close/i.test(line) && !/^exception ignored/i.test(line));
  const optionError = lines.filter((line) => /OptionError|lower than minimum|higher than maximum|is not a valid (?:option|choice|value)|unknown option/i.test(line)).at(-1);
  const significant = optionError || lines.filter((line) => /(?:RuntimeError|ValueError|Exception):/.test(line)).at(-1);
  return (significant || lines.at(-1))?.slice(0, 300) || fallback;
}

function validateRequest(payload) {
  if (!payload || typeof payload.installRoot !== 'string' || !Array.isArray(payload.templates) || payload.templates.length < 1 || payload.templates.length > MAX_TEMPLATES) {
    throw new Error(`Choose between 1 and ${MAX_TEMPLATES} YAMLs to validate.`);
  }
  return payload.templates.map((template, index) => {
    const id = String(template?.id ?? '');
    const content = String(template?.content ?? '');
    if (!id || id.length > 160) throw new Error(`Template ${index + 1} has an invalid ID.`);
    if (!content || Buffer.byteLength(content, 'utf8') > MAX_YAML_BYTES) throw new Error(`Template ${index + 1} is empty or larger than 2 MB.`);
    const sourceFingerprint = template.sourceFingerprint === undefined ? undefined : String(template.sourceFingerprint);
    if (sourceFingerprint !== undefined && !/^[a-f0-9]{16}$/i.test(sourceFingerprint)) throw new Error(`Template ${index + 1} has an invalid source fingerprint.`);
    return { id, fileName: String(template.fileName || `Player-${index + 1}.yaml`), content, sourceFingerprint };
  });
}

function readGame(content) {
  try {
    const document = YAML.parse(content);
    if (!document || typeof document !== 'object' || Array.isArray(document)) return { error: 'YAML root must be a mapping.' };
    if (typeof document.game !== 'string' || !document.game.trim()) return { error: 'YAML does not contain a game name.' };
    return { game: document.game.trim(), document };
  } catch (error) { return { error: error instanceof Error ? error.message.split('\n')[0] : 'Unable to parse YAML.' }; }
}

const COMMON_YAML_KEYS = new Set(['name', 'description', 'game', 'requires', 'linked_options', 'triggers', 'plando_items', 'plando_connections']);

async function loadGeneratedSchemas(installRoot) {
  const schemas = new Map();
  const root = path.join(installRoot, 'Players', 'Templates');
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isFile() && /\.ya?ml$/i.test(item.name))) {
      try {
        const document = YAML.parse(await fs.readFile(path.join(root, entry.name), 'utf8'));
        if (!document || typeof document !== 'object' || Array.isArray(document) || typeof document.game !== 'string') continue;
        const game = document.game.trim();
        const options = document[game];
        schemas.set(game.toLocaleLowerCase('en-US'), {
          topLevel: new Set(Object.keys(document)),
          options: options && typeof options === 'object' && !Array.isArray(options) ? new Set(Object.keys(options)) : null,
        });
      } catch { /* a malformed generated template is not an authoritative schema */ }
    }
  } catch { /* template generation is optional */ }
  return schemas;
}

function schemaError(parsed, schemas) {
  if (!parsed.document || !parsed.game) return null;
  const schema = schemas.get(parsed.game.toLocaleLowerCase('en-US'));
  const allowedTop = new Set([...COMMON_YAML_KEYS, parsed.game, ...(schema?.topLevel || [])]);
  const unknownTop = Object.keys(parsed.document).filter((key) => !allowedTop.has(key));
  if (unknownTop.length) return `Unknown top-level YAML option${unknownTop.length === 1 ? '' : 's'}: ${unknownTop.join(', ')}.`;
  const gameOptions = parsed.document[parsed.game];
  if (schema?.options && gameOptions && typeof gameOptions === 'object' && !Array.isArray(gameOptions)) {
    const unknownOptions = Object.keys(gameOptions).filter((key) => !schema.options.has(key));
    if (unknownOptions.length) return `Unknown ${parsed.game} option${unknownOptions.length === 1 ? '' : 's'}: ${unknownOptions.join(', ')}.`;
  }
  return null;
}

function slotLockContextIssue(slotLock, allTemplates) {
  if (allTemplates.length < 2) return { status: 'Context required', message: 'Select SlotLock together with the player YAMLs it controls, then run the Session Build AP check.' };
  const roster = allTemplates.map((template) => typeof template.parsed.document?.name === 'string' ? template.parsed.document.name.trim() : '');
  if (roster.some((name) => !name)) return { status: 'Rejected', message: 'Every YAML in a SlotLock session must have one deterministic string slot name.' };
  const duplicates = roster.filter((name, index) => roster.findIndex((candidate) => candidate.toLowerCase() === name.toLowerCase()) !== index);
  if (duplicates.length) return { status: 'Rejected', message: `SlotLock session has duplicate slot names: ${[...new Set(duplicates)].join(', ')}.` };
  const options = slotLock.parsed.document?.[slotLock.parsed.game];
  if (!options || typeof options !== 'object' || Array.isArray(options)) return { status: 'Rejected', message: 'SlotLock options must be a mapping.' };
  const references = Array.isArray(options.slots_to_lock) ? options.slots_to_lock.map(String) : [];
  if (options.associated_worlds && typeof options.associated_worlds === 'object' && !Array.isArray(options.associated_worlds)) {
    for (const [primary, associated] of Object.entries(options.associated_worlds)) {
      references.push(primary);
      if (Array.isArray(associated)) references.push(...associated.map(String));
    }
  }
  const rosterKeys = new Set(roster.map((name) => name.toLowerCase()));
  const missing = [...new Set(references.filter((name) => !rosterKeys.has(name.toLowerCase())))];
  if (missing.length) return { status: 'Rejected', message: `SlotLock references slots that are not in this session: ${missing.join(', ')}.` };
  const ownName = typeof slotLock.parsed.document.name === 'string' ? slotLock.parsed.document.name.trim() : '';
  if (references.some((name) => name.toLowerCase() === ownName.toLowerCase())) return { status: 'Rejected', message: `SlotLock cannot target its own slot, ${ownName}.` };
  const listed = new Set((Array.isArray(options.slots_to_lock) ? options.slots_to_lock : []).map((name) => String(name).toLowerCase()));
  const lockTargets = options.slots_whitelist === false
    ? roster.filter((name) => name.toLowerCase() !== ownName.toLowerCase() && !listed.has(name.toLowerCase()))
    : roster.filter((name) => listed.has(name.toLowerCase()));
  const randomUnlocked = typeof options.random_unlocked_slots === 'number' ? options.random_unlocked_slots : 0;
  if (randomUnlocked > lockTargets.length) return { status: 'Rejected', message: `random_unlocked_slots is ${randomUnlocked}, but this session has only ${lockTargets.length} locked slot${lockTargets.length === 1 ? '' : 's'}.` };
  if (options.free_starting_items === false && randomUnlocked === 0 && lockTargets.length === roster.length - 1) return { status: 'Rejected', message: 'SlotLock would lock every playable slot without a starting unlock.' };
  return null;
}

function slotLockOptionIssue(parsed) {
  if (parsed.game?.toLowerCase() !== 'slotlock') return null;
  const options = parsed.document?.[parsed.game];
  if (!options || typeof options !== 'object' || Array.isArray(options)) return 'SlotLock options must be a mapping.';
  const ranges = {
    unlock_item_copies: [1, 10],
    unlock_item_filler: [0, 9],
    bonus_item_slots: [0, 1000],
    bonus_item_copies: [1, 10],
    bonus_item_filler: [0, 9],
    free_unlocked_world_items: [0, 10],
    random_unlocked_slots: [0, 100],
  };
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    const value = options[key];
    if (value === undefined || typeof value !== 'number') continue;
    if (!Number.isInteger(value) || value < minimum || value > maximum) return `${key} must be a whole number from ${minimum} to ${maximum}; received ${value}.`;
  }
  if (options.slots_to_lock !== undefined && !Array.isArray(options.slots_to_lock)) return 'slots_to_lock must be a list of slot names.';
  if (Array.isArray(options.slots_to_lock) && options.slots_to_lock.some((name) => typeof name !== 'string' || !name.trim())) return 'slots_to_lock contains an invalid slot name.';
  return null;
}

function runGenerator(command, args, cwd, state) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1' } });
    state.current = child;
    const append = (chunk) => {
      if (output.length <= MAX_OUTPUT_CHARS) output += chunk.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, VALIDATION_TIMEOUT_MS);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.current = null;
      resolve({ ...value, output, durationMs: Date.now() - started });
    };
    child.once('error', (error) => finish({ exitCode: -1, error: error.message, timedOut: false }));
    child.once('close', (exitCode) => finish({ exitCode, timedOut, cancelled: state.cancelled && !timedOut }));
  });
}

function createYamlValidator({ resolveGames, onBusy = () => {}, run = runGenerator }) {
  let active = null;

  async function validate(payload, sender) {
    if (active) throw new Error('YAML validation is already running.');
    const templates = validateRequest(payload);
    const installRoot = path.resolve(payload.installRoot);
    const generator = path.join(installRoot, 'ArchipelagoGenerate.exe');
    if (!await fs.access(generator).then(() => true).catch(() => false)) throw new Error('ArchipelagoGenerate.exe was not found in the installation folder.');
    const parsed = templates.map((template) => ({ ...template, parsed: readGame(template.content) }));
    const matches = await resolveGames({ installRoot, games: parsed.map((item) => item.parsed.game || '') });
    const schemas = await loadGeneratedSchemas(installRoot);
    const jobId = randomUUID();
    const state = { jobId, cancelled: false, current: null };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archipelago-controller-validation-'));
    active = state;
    onBusy(true);
    const results = [];
    const sessionContext = payload.sessionContext === true;
    const contextFingerprint = sessionContext ? yamlFingerprint(templates.map((template) => template.content).join('\u0000')) : undefined;
    let contextRun;
    const send = (value) => {
      if (sender && !sender.isDestroyed()) sender.send('yaml:validation-progress', value);
    };
    send({ jobId, index: 0, total: templates.length, state: 'started' });
    try {
      for (let index = 0; index < parsed.length; index += 1) {
        const template = parsed[index];
        const match = matches[index];
        send({ jobId, templateId: template.id, index, total: templates.length, state: 'checking' });
        const started = Date.now();
        const fingerprint = template.sourceFingerprint || yamlFingerprint(template.content);
        const schemaIssue = schemaError(template.parsed, schemas);
        const slotLockIssue = template.parsed.error ? null : slotLockOptionIssue(template.parsed);
        let result;
        if (state.cancelled) {
          result = { status: 'Cancelled', checkedAt: new Date().toISOString(), fingerprint, worldSignature: match.signature, message: 'Validation was cancelled.', output: '', durationMs: 0 };
        } else if (template.parsed.error) {
          result = { status: 'Rejected', checkedAt: new Date().toISOString(), fingerprint, worldSignature: match.signature, message: template.parsed.error, output: template.parsed.error, durationMs: Date.now() - started };
        } else if (slotLockIssue) {
          result = { status: 'Rejected', checkedAt: new Date().toISOString(), fingerprint, worldSignature: match.signature, message: slotLockIssue, output: slotLockIssue, durationMs: Date.now() - started };
        } else if (schemaIssue && match.status !== 'Installed with override' && !match.candidates.some((candidate) => candidate.source === 'custom-legacy')) {
          result = { status: 'Rejected', checkedAt: new Date().toISOString(), fingerprint, worldSignature: match.signature, message: schemaIssue, output: schemaIssue, durationMs: Date.now() - started };
        } else if (['Missing', 'Installed but incompatible', 'Ambiguous'].includes(match.status)) {
          result = { status: 'Rejected', checkedAt: new Date().toISOString(), fingerprint, worldSignature: match.signature, message: match.message, output: match.message, durationMs: Date.now() - started };
        } else {
          const itemRoot = path.join(root, String(index));
          const input = path.join(itemRoot, 'players');
          const output = path.join(itemRoot, 'output');
          await fs.mkdir(input, { recursive: true });
          await fs.mkdir(output, { recursive: true });
          const isSlotLock = template.parsed.game.toLowerCase() === 'slotlock';
          const contextIssue = isSlotLock && sessionContext ? slotLockContextIssue(template, parsed) : null;
          if (contextIssue) {
            result = { status: contextIssue.status, checkedAt: new Date().toISOString(), fingerprint, worldSignature: match.signature, contextFingerprint, message: contextIssue.message, output: contextIssue.message, durationMs: Date.now() - started };
            results.push({ templateId: template.id, result });
            send({ jobId, templateId: template.id, index: index + 1, total: templates.length, state: 'complete', result });
            continue;
          }
          let processResult;
          if (isSlotLock && sessionContext) {
            if (!contextRun) contextRun = (async () => {
              for (let fileIndex = 0; fileIndex < templates.length; fileIndex += 1) {
                const safeName = templates[fileIndex].fileName.replace(/[^a-z0-9_.-]+/gi, '_').replace(/\.ya?ml$/i, '') || 'Player';
                await fs.writeFile(path.join(input, `${String(fileIndex + 1).padStart(3, '0')}-${safeName}.yaml`), templates[fileIndex].content, 'utf8');
              }
              const seed = BigInt(`0x${contextFingerprint.slice(0, 14)}`).toString();
              return run(generator, ['--player_files_path', input, '--outputpath', output, '--multi', String(templates.length), '--seed', seed, '--skip_output'], installRoot, state);
            })();
            processResult = await contextRun;
          } else {
            await fs.writeFile(path.join(input, 'Player.yaml'), template.content, 'utf8');
            const seed = BigInt(`0x${yamlFingerprint(template.content).slice(0, 14)}`).toString();
            processResult = await run(generator, ['--player_files_path', input, '--outputpath', output, '--multi', '1', '--seed', seed, '--skip_output'], installRoot, state);
          }
          const cleanOutput = sanitizeOutput(`${processResult.output}${processResult.error ? `\n${processResult.error}` : ''}`, root, installRoot);
          let status = processResult.timedOut ? 'Timed out' : processResult.cancelled ? 'Cancelled' : processResult.exitCode === 0 ? 'Valid' : classifyFailure(cleanOutput);
          const hasConcreteOptionError = /OptionError|lower than minimum|higher than maximum|is not a valid (?:option|choice|value)|unknown option/i.test(cleanOutput);
          if (isSlotLock && !sessionContext && (status === 'Valid' || (/Too many random unlocked slots/i.test(cleanOutput) && !hasConcreteOptionError))) status = 'Context required';
          result = { status, checkedAt: new Date().toISOString(), fingerprint, worldSignature: match.signature, ...(isSlotLock && sessionContext ? { contextFingerprint } : {}), message: resultMessage(status, cleanOutput, `Archipelago exited with code ${processResult.exitCode}.`), output: cleanOutput, durationMs: processResult.durationMs };
        }
        results.push({ templateId: template.id, result });
        send({ jobId, templateId: template.id, index: index + 1, total: templates.length, state: 'complete', result });
      }
      if (state.cancelled) send({ jobId, index: results.length, total: templates.length, state: 'cancelled' });
      return { ok: true, jobId, results };
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      active = null;
      onBusy(false);
    }
  }

  function cancel() {
    if (!active) return { ok: true, cancelled: false };
    active.cancelled = true;
    if (active.current && active.current.exitCode === null) active.current.kill();
    return { ok: true, cancelled: true };
  }

  return { validate, cancel, isRunning: () => Boolean(active) };
}

module.exports = { classifyFailure, createYamlValidator, readGame, sanitizeOutput, schemaError, slotLockContextIssue, slotLockOptionIssue, validateRequest, yamlFingerprint };
