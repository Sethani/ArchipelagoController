const MAX_SPHERE_HTML_BYTES = 16 * 1024 * 1024;

function decodeHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|#39);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === '#39') return "'";
    const code = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  }).replace(/\s+/g, ' ').trim();
}

function parseOfficialSphereHtml(html, dashboard, packages, refreshedAt = new Date().toISOString()) {
  const source = String(html || '');
  if (Buffer.byteLength(source, 'utf8') > MAX_SPHERE_HTML_BYTES) return { refreshedAt, available: false, reason: 'malformed', checks: [] };
  if (/has no Sphere data/i.test(source)) return { refreshedAt, available: false, reason: 'old-seed', checks: [] };
  const body = source.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (body === undefined) return { refreshedAt, available: false, reason: 'malformed', checks: [] };

  const players = Array.isArray(dashboard?.players) ? dashboard.players : [];
  const playerNames = new Map();
  for (const player of players) {
    playerNames.set(String(player.name || '').trim().toLocaleLowerCase(), player);
    if (player.alias) playerNames.set(String(player.alias).trim().toLocaleLowerCase(), player);
  }
  const checks = [];
  for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decodeHtml(cell[1]));
    if (cells.length !== 6) continue;
    const sphere = Number(cells[0]);
    const finder = playerNames.get(cells[1].toLocaleLowerCase());
    const receiver = playerNames.get(cells[2].toLocaleLowerCase());
    const finderGame = finder?.game || cells[5];
    const receiverGame = receiver?.game || 'Unknown';
    const itemId = Number(packages?.[receiverGame]?.item_name_to_id?.[cells[3]] ?? 0);
    const locationId = Number(packages?.[finderGame]?.location_name_to_id?.[cells[4]] ?? 0);
    if (!Number.isInteger(sphere) || sphere < 1 || !finder || !receiver) continue;
    checks.push({
      sphere, finderSlot: Number(finder.slot), finderName: String(finder.name), finderGame: String(finderGame),
      receiverSlot: Number(receiver.slot), receiverName: String(receiver.name), receiverGame: String(receiverGame),
      itemId, item: cells[3], locationId, location: cells[4],
    });
  }
  return { refreshedAt, available: true, checks };
}

module.exports = { MAX_SPHERE_HTML_BYTES, decodeHtml, parseOfficialSphereHtml };
