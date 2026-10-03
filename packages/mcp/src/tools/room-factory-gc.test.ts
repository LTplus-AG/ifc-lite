/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const mcp = fileURLToPath(new URL('../../', import.meta.url));
const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const available = existsSync(wasm);
if (!available) console.warn('Run pnpm build:wasm for the real native Room factory GC control');

it.skipIf(!available)('#6232 retaining a native Room factory releases the reparsed IFC source', () => {
  const result = spawnSync(process.execPath, [
    '--expose-gc', '--import', 'tsx',
    fileURLToPath(new URL('../test/room-factory-gc-probe.mjs', import.meta.url)),
    root, fileURLToPath(new URL('../headless-room-geometry.ts', import.meta.url)),
  ], { cwd: mcp, encoding: 'utf8', timeout: 60_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 70_000);
