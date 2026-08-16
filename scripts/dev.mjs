/**
 * `npm run dev`.
 *
 * Two processes: Vite rebuilding the site on every save, and Anna's server
 * restarting on every save. Spawned from Node rather than chained with `&`
 * because `&` is not a thing in PowerShell, and Windows is a supported target.
 *
 * Both are killed together. A stray `vite build --watch` holding a file handle
 * on `dist/web` after the server is gone is a genuinely confusing five minutes.
 */

import { spawn } from 'node:child_process';

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
