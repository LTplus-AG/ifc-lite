/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe('@ifc-lite/wasm packaging', () => {
  it('declares every exported payload directory as a turbo build output', () => {
    // A cached `build` restores only declared outputs: a payload missing here
    // (pkg-rhino once was) is absent after a cache hit and its export fails to load.
    const { exports } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const targets = Object.values(exports).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target)));
    const payloads = [...new Set(targets.map((target) => target.split('/')[1]).filter((dir) => dir.startsWith('pkg')))];
    const { outputs } = JSON.parse(readFileSync(join(packageDir, '../../turbo.json'), 'utf8')).tasks.build;
    assert.deepEqual(payloads.filter((dir) => !outputs.includes(`${dir}/**`)), []);
  });

  it('packs the core wasm files into the published tarball', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'ifc-lite-wasm-pack-'));

    try {
      execFileSync('pnpm', ['pack', '--pack-destination', packDir], {
        cwd: packageDir,
        stdio: 'pipe',
      });

      const [tarball] = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
      assert.ok(tarball, 'expected pnpm pack to produce a tarball');

      const listing = execFileSync('tar', ['-tf', join(packDir, tarball)], {
        encoding: 'utf8',
      });

      assert.match(listing, /package\/pkg\/ifc-lite\.js/);
      assert.match(listing, /package\/pkg\/ifc-lite\.d\.ts/);
      assert.match(listing, /package\/pkg\/ifc-lite_bg\.wasm/);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});
