const fs = require('node:fs/promises');
const path = require('node:path');
const { unzipSync } = require('fflate');

function safeEntryPath(root, entryName) {
  const normalized = String(entryName).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (!normalized || normalized.startsWith('/') || parts.some((part) => part === '..' || part.includes(':') || part.includes('\0'))) {
    throw new Error(`Unsafe ZIP entry: ${entryName}`);
  }
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe ZIP entry: ${entryName}`);
  return target;
}

async function extractZip(zipPath, destination) {
  const root = path.resolve(destination);
  const entries = unzipSync(new Uint8Array(await fs.readFile(zipPath)));
  await fs.mkdir(root, { recursive: true });
  for (const [entryName, contents] of Object.entries(entries)) {
    const target = safeEntryPath(root, entryName);
    if (entryName.endsWith('/') || entryName.endsWith('\\')) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
}

module.exports = { extractZip, safeEntryPath };
