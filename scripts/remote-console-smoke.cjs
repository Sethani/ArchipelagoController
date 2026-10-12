const fs = require('node:fs');
const crypto = require('node:crypto');

const [address, slotName, hostYamlPath] = process.argv.slice(2);
if (!address || !slotName || !hostYamlPath) {
  console.error('Usage: node scripts/remote-console-smoke.cjs <wss-url> <slot> <host.yaml>');
  process.exit(1);
}

const yaml = fs.readFileSync(hostYamlPath, 'utf8');
function setting(name) {
  const match = yaml.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return '';
  const value = match[1].trim();
  if (/^(null|none|''|"")$/i.test(value)) return '';
  return value.replace(/^['"]|['"]$/g, '');
}

const socket = new WebSocket(address);
const timeout = setTimeout(() => finish(2, 'TIMEOUT'), 20_000);
let finished = false;

function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (message) (code ? console.error : console.log)(message);
  process.exitCode = code;
  socket.close();
}

socket.addEventListener('message', (event) => {
  for (const packet of JSON.parse(event.data)) {
    if (packet.cmd === 'RoomInfo') {
      console.log(`ROOM_INFO ${packet.version?.major}.${packet.version?.minor}.${packet.version?.build}`);
      socket.send(JSON.stringify([{
        cmd: 'Connect', password: setting('password'), name: slotName,
        version: { major: 0, minor: 6, build: 7, class: 'Version' },
        tags: ['AP', 'IgnoreGame', 'TextOnly'], items_handling: 0,
        uuid: crypto.randomUUID(), game: '', slot_data: false,
      }]));
    } else if (packet.cmd === 'Connected') {
      console.log('SLOT_CONNECTED');
      socket.send(JSON.stringify([{ cmd: 'Say', text: `!admin login ${setting('server_password')}` }]));
    } else if (packet.cmd === 'ConnectionRefused') {
      finish(3, `REFUSED ${JSON.stringify(packet.errors)}`);
    } else if (packet.cmd === 'PrintJSON') {
      const text = (packet.data || []).map((part) => part.text || '').join('');
      if (/login successful/i.test(text)) finish(0, 'ADMIN_AUTHENTICATED');
      else if (/password incorrect|administration is disabled|must first login/i.test(text)) finish(4, `ADMIN_FAILED ${text}`);
    }
  }
});

socket.addEventListener('error', () => finish(5, 'WEBSOCKET_ERROR'));
socket.addEventListener('close', (event) => {
  if (!finished) finish(6, `CLOSED_EARLY ${event.code} ${event.reason}`);
});
