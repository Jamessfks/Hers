/**
 * `npm run dev`.
 *
 * Two processes: Vite rebuilding the site on every save, and the local server
 * restarting on every save. Spawned from Node rather than chained with `&`
 * because `&` is not a thing in PowerShell, and Windows is a supported target.
 *
 * Both are killed together. A stray `vite build --watch` holding a file handle
 * on `dist/web` after the server is gone is a genuinely confusing five minutes.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const PORT = Number(process.env.HERS_PORT ?? 5175);
const HOST = process.env.HERS_HOST ?? '127.0.0.1';

/**
 * Checked before anything is started, because of how the failure looks.
 *
 * `node --watch` restarts a process that exits, so a server that cannot bind
 * fails, restarts, fails again — and the one line saying why scrolls past
 * inside a wall of Vite output. Worse, the port is usually held by a copy the
 * developer forgot was running, so the symptom is "my changes do nothing":
 * the browser is talking to the old one.
 */
async function portIsFree() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(PORT, HOST);
  });
}

if (!(await portIsFree())) {
  console.error(
    `\n  Port ${PORT} is already in use — almost certainly a copy of Hers you started earlier.\n` +
      `  Stop it first:\n\n` +
      `    pkill -f "src/server/index.ts"\n\n` +
      `  or run this one somewhere else:\n\n` +
      `    HERS_PORT=5176 npm run dev\n`,
  );
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [
  spawn(npm, ['run', 'build', '--', '--watch', '--logLevel', 'warn'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }),
  spawn(process.execPath, ['--watch', '--watch-preserve-output', 'src/server/index.ts'], {
    stdio: 'inherit',
  }),
];

let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300).unref();
}

for (const child of children) {
  child.on('exit', (code) => stop(code ?? 0));
  child.on('error', (error) => {
    console.error(error);
    stop(1);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
