#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `pnpm collab:demo:3d` driver.
 *
 * Boots `@ifc-lite/collab-server` on :1234 and `examples/threejs-collab`
 * on :5175 in parallel.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const COLOR = {
  reset: '\x1b[0m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
};

function launch(name, cmd, args, color, cwd = repoRoot, env = process.env) {
  const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `${color}[${name}]${COLOR.reset} `;
  for (const stream of ['stdout', 'stderr']) {
    proc[stream].on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) {
          process[stream === 'stderr' ? 'stderr' : 'stdout'].write(`${tag}${line}\n`);
        }
      }
    });
  }
  proc.on('exit', (code) => {
    process.stdout.write(`${tag}exited with code ${code}\n`);
    if (code !== 0 && !shuttingDown) shutdown(code ?? 1);
  });
  return proc;
}

let shuttingDown = false;
const procs = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    if (!p.killed) p.kill('SIGINT');
  }
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

procs.push(
  launch('server', 'node', ['packages/collab-server/dist/bin.js'], COLOR.blue),
);

procs.push(
  launch('vite', 'pnpm', ['--filter', 'ifc-lite-collab-3d-demo', 'dev'], COLOR.magenta),
);

process.stdout.write(
  `${COLOR.yellow}\n  ✦ collab 3D demo ready\n  → server: ws://localhost:1234\n  → vite:   http://localhost:5175\n  Open http://localhost:5175 in TWO browser tabs to see live 3D walls.${COLOR.reset}\n\n`,
);
