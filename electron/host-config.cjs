const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');

function validateHostDocument(value, depth = 0) {
  if (depth > 12) throw new Error('host.yaml nesting is too deep.');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error('host.yaml contains an oversized list.');
    value.forEach((item) => validateHostDocument(item, depth + 1));
    return;
  }
  if (typeof value !== 'object') throw new Error('host.yaml contains an unsupported value.');
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 160 || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('host.yaml contains an invalid option name.');
    validateHostDocument(item, depth + 1);
  }
}

function cleanComment(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.replace(/^\s?/, '').trimEnd()).join('\n').trim();
}

function extractHostComments(yamlDocument) {
  const comments = {};
  const walk = (node, optionPath = []) => {
    if (!YAML.isMap(node)) return;
    const firstComment = cleanComment(node.commentBefore);
    node.items.forEach((pair, index) => {
      const key = String(pair.key?.value ?? '');
      if (!key) return;
      const nextPath = [...optionPath, key];
      const before = cleanComment(pair.key?.commentBefore)
        || (!YAML.isMap(pair.value) ? cleanComment(pair.value?.commentBefore) : '')
        || (index === 0 ? firstComment : '');
      const inline = cleanComment(pair.key?.comment) || cleanComment(pair.value?.comment);
      const description = [before, inline].filter(Boolean).join('\n');
      if (description) comments[nextPath.join('.')] = description;
      walk(pair.value, nextPath);
    });
  };
  walk(yamlDocument.contents);
  return comments;
}

async function installedHostPath(installRoot) {
  const root = path.resolve(String(installRoot ?? ''));
  await fs.access(path.join(root, 'manifest.json'));
  return path.join(root, 'host.yaml');
}

async function readHostConfig(installRoot) {
  const sourcePath = await installedHostPath(installRoot);
  const text = await fs.readFile(sourcePath, 'utf8');
  const yamlDocument = YAML.parseDocument(text);
  const parsed = yamlDocument.toJS() || {};
  validateHostDocument(parsed);
  const document = JSON.parse(JSON.stringify(parsed));
  if (document.server_options && typeof document.server_options === 'object') {
    document.server_options.password = null;
    document.server_options.server_password = null;
  }
  return { ok: true, document, comments: extractHostComments(yamlDocument), sourcePath };
}

async function writeHostConfig({ installRoot, document: input }) {
  validateHostDocument(input);
  const target = await installedHostPath(installRoot);
  const serialized = JSON.stringify(input);
  if (serialized.length > 2 * 1024 * 1024) throw new Error('host.yaml is unexpectedly large.');
  const existingText = await fs.readFile(target, 'utf8');
  const existing = YAML.parse(existingText) || {};
  const document = JSON.parse(serialized);
  document.server_options ||= {};
  document.server_options.password = existing.server_options?.password ?? null;
  document.server_options.server_password = existing.server_options?.server_password ?? null;
  const yamlDocument = YAML.parseDocument(existingText);
  const sync = (value, current, optionPath = []) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) yamlDocument.setIn(optionPath, {});
      const nextRecord = value;
      const currentRecord = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
      for (const key of Object.keys(currentRecord)) {
        if (!(key in nextRecord)) yamlDocument.deleteIn([...optionPath, key]);
      }
      for (const [key, item] of Object.entries(nextRecord)) sync(item, currentRecord[key], [...optionPath, key]);
      return;
    }
    const node = yamlDocument.getIn(optionPath, true);
    if (YAML.isScalar(node) && !Array.isArray(value)) node.value = value;
    else yamlDocument.setIn(optionPath, value);
  };
  sync(document, existing);
  const temporary = `${target}.controller.tmp`;
  const backup = `${target}.controller-backup`;
  await fs.writeFile(temporary, yamlDocument.toString(), 'utf8');
  try {
    await fs.copyFile(target, backup);
    await fs.copyFile(temporary, target);
  } catch (error) {
    await fs.copyFile(backup, target).catch(() => {});
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { ok: true, path: target, backupPath: backup };
}

module.exports = { extractHostComments, readHostConfig, validateHostDocument, writeHostConfig };
