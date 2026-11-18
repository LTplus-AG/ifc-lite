#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = spawnSync('pnpm', ['exec', 'tsx', '--tsconfig', 'apps/viewer/tsconfig.json', '--import', './apps/viewer/src/test/vite-module-hooks.mjs', 'scripts/generate-viewer-operations.ts', ...(process.argv.includes('--update') ? [] : ['--check'])], { cwd: root, stdio: 'inherit', env: process.env });
if (run.error) console.error(run.error);
process.exit(run.status ?? 1);
