/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256, verifyNightProfile, type NightProfile } from './frame-gpu-night-profile.js';

/** Real temporary Git checkout and on-disk files; not native GPU evidence. */
function fixture(run: (root: string, profile: NightProfile, bytes: Buffer) => void): void {
  const root = mkdtempSync(join(tmpdir(), '6975-night-profile-'));
  const put = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    put('.gitignore', 'dist/\npackages/wasm/pkg/\n');
    put('rust/source.rs', '// source identity invariant\n');
    put('fixture.ifc', 'synthetic bytes for source/fixture drift control');
    put('review.json', '{"testOnly":true}');
    git('init', '--quiet'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('add', '.'); git('commit', '--quiet', '-m', 'source fixture');
    const artifacts = ['dist/index.html', 'dist/assets/viewer.js', 'fixture.ifc', 'review.json',
      'packages/wasm/pkg/ifc-lite_bg.wasm', 'packages/wasm/pkg/ifc-lite.js', 'packages/wasm/pkg/ifc-lite.d.ts'];
    for (const path of artifacts.filter((path) => path.startsWith('dist/') || path.startsWith('packages/'))) put(path, `test-only-${path}`);
    const profile: NightProfile = {
      version: 1, sourceHead: git('rev-parse', 'HEAD'), rustTree: git('rev-parse', 'HEAD:rust'),
      dist: 'dist', fixture: 'fixture.ifc', qualificationReceipt: 'review.json', hostProfile: 'test-only-profile',
      artifacts: artifacts.map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
    };
    run(root, profile, Buffer.from(JSON.stringify(profile)));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('#6975 matching immutable profile verifies real Git identity and actual on-disk bytes', () => fixture((root, profile, bytes) => {
  assert.equal(verifyNightProfile(root, bytes).profileSha256, sha256(bytes));
  writeFileSync(join(root, 'dist/assets/viewer.js'), 'a stale or changed build');
  assert.throws(() => verifyNightProfile(root, bytes), /artifact changed/);
  // Recomputing one file is not sufficient when the intended source identity changed.
  const changed = { ...profile, sourceHead: '0'.repeat(40) };
  assert.throws(() => verifyNightProfile(root, Buffer.from(JSON.stringify(changed))), /source or Rust tree changed/);
}));

test('#6975 extra build assets, missing pins and modified source refuse launch', () => fixture((root, profile, bytes) => {
  writeFileSync(join(root, 'dist/assets/unpinned.js'), 'unqualified asset');
  assert.throws(() => verifyNightProfile(root, bytes), /unpinned viewer artifact/);
  rmSync(join(root, 'dist/assets/unpinned.js'));
  const missing = { ...profile, artifacts: profile.artifacts.filter((row) => row.path !== 'packages/wasm/pkg/ifc-lite_bg.wasm') };
  assert.throws(() => verifyNightProfile(root, Buffer.from(JSON.stringify(missing))), /required profile artifact unpinned/);
  writeFileSync(join(root, 'rust/source.rs'), 'uncommitted source');
  assert.throws(() => verifyNightProfile(root, bytes), /checkout is dirty/);
}));

test('#6975 artifact paths cannot escape the checkout or alias one pinned allocation', () => fixture((root, profile) => {
  for (const path of ['/etc/passwd', '../outside-file']) {
    const invalid = { ...profile, artifacts: [{ path, sha256: 'a'.repeat(64) }] };
    assert.throws(() => verifyNightProfile(root, Buffer.from(JSON.stringify(invalid))));
  }
  const duplicate = { ...profile, artifacts: [...profile.artifacts, { ...profile.artifacts[0], path: 'dist/./index.html' }] };
  assert.throws(() => verifyNightProfile(root, Buffer.from(JSON.stringify(duplicate))), /multiple profile paths/);
}));
