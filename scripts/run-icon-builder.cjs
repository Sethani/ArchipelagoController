const { spawnSync } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [path.join(__dirname, 'build-icon.cjs')], {
  cwd: path.resolve(__dirname, '..'),
  env,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
