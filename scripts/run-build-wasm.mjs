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

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchThreadedDevStub } from './lib/patch-threaded-stub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const script = resolve(rootDir, 'scripts/build-wasm.sh');

const threaded =
  process.argv.includes('--threaded') || process.env.THREADED === '1';

// Vercel cost-cutter: when IFC_LITE_THREADED_STUB=1 is set AND we're
// building the threaded bundle, skip the second 2m+ wasm-pack compile.
// The published threaded path is gated behind
// `localStorage['ifc-lite:single-controller']==='1'` and the controller
// worker already falls back to per-task serial execution when
// `initThreadPool` is a no-op (see apps/viewer/src/hooks/useIfcLoader.ts).
// So we copy the already-built single-thread pkg into the threaded
// destination and use `patchThreadedDevStub` to add the no-op
// `initThreadPool` re-export. Same trick `scripts/fetch-prebuilt-wasm.mjs`
// uses for offline-from-npm dev installs.
if (threaded && process.env.IFC_LITE_THREADED_STUB === '1') {
  const sourcePkg = resolve(rootDir, 'packages/wasm/pkg');
  const destPkg = resolve(rootDir, 'packages/wasm-threaded/pkg');

  if (!existsSync(sourcePkg)) {
    console.error(
      `❌ IFC_LITE_THREADED_STUB=1 set but source pkg ${sourcePkg} is missing.\n` +
        '   The single-thread @ifc-lite/wasm build must run first. Check that\n' +
        '   turbo sequences `@ifc-lite/wasm:build` before `@ifc-lite/wasm-threaded:build`.',
    );
    process.exit(1);
  }

  rmSync(destPkg, { recursive: true, force: true });
  mkdirSync(destPkg, { recursive: true });
  cpSync(sourcePkg, destPkg, { recursive: true, force: true });

  patchThreadedDevStub(destPkg);
  console.log(
    `🧵 IFC_LITE_THREADED_STUB=1 → copied ${sourcePkg} → ${destPkg}\n` +
      '   (threaded bundle stubbed; opt-in single-controller path falls back\n' +
      '   to per-task serial execution per useIfcLoader.ts).',
  );
  process.exit(0);
}

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
