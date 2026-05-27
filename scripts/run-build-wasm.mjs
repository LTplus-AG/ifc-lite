/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-platform launcher for scripts/build-wasm.sh.
 *
 * On Windows, `bash` often resolves to WSL (which may be uninstalled).
 * This script prefers Git Bash when available and forwards THREADED=1
 * without Unix-style inline env assignment.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchThreadedDevStub } from './lib/patch-threaded-stub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const script = resolve(rootDir, 'scripts/build-wasm.sh');

const threaded =
  process.argv.includes('--threaded') || process.env.THREADED === '1';

function findBash() {
  if (process.platform === 'win32') {
    const candidates = [
      process.env.BASH_PATH,
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'bash';
}

const env = { ...process.env };
if (threaded) env.THREADED = '1';

const bash = findBash();
const result = spawnSync(bash, [script], {
  cwd: rootDir,
  env,
  stdio: 'inherit',
  shell: false,
});

if (result.status === 0 && threaded) {
  patchThreadedDevStub(resolve(rootDir, 'packages/wasm-threaded/pkg'));
}

process.exit(result.status ?? 1);
