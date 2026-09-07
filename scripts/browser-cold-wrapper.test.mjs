/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const [corruptServedWasm, dirtyWorkingTree] of [[false, false], [true, false], [false, true]]) test(`#3978 source build/cleanup (corrupt: ${corruptServedWasm}, dirty: ${dirtyWorkingTree})`, () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-wrapper-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'scripts/perf'), { recursive: true });
  mkdirSync(join(repo, 'apps/viewer/dist'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, '.gitignore'), 'packages/wasm/pkg/\napps/viewer/dist/\n');
  copyFileSync(resolve('scripts/perf/browser-cold-ab.sh'), join(repo, 'scripts/perf/browser-cold-ab.sh'));
  writeFileSync(join(repo, 'scripts/build-wasm.sh'), '#!/bin/sh\nmkdir -p packages/wasm/pkg\nprintf fixture-wasm > packages/wasm/pkg/ifc-lite_bg.wasm\n');
  const git = args => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    if (dirtyWorkingTree) writeFileSync(join(repo, 'uncommitted-source.txt'), 'uncommitted');
    // Build tools are bounded stubs; git worktree registration and shell traps are real.
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nif [ \"$1\" = install ]; then exit 0; fi\nmkdir -p apps/viewer/dist/assets\ncp packages/wasm/pkg/ifc-lite_bg.wasm apps/viewer/dist/assets/ifc-lite_bg-test.wasm\nif [ \"$WRAPPER_CORRUPT_WASM\" = 1 ]; then printf wrong-engine > apps/viewer/dist/assets/ifc-lite_bg-test.wasm; fi\n', { mode: 0o755 });
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' \"$@\"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'wasm-pack'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'npx'), `#!/bin/sh
previous=''
for arg in "$@"; do
  if [ "$previous" = '--dist-base' ]; then
    test -d "$arg" || exit 91
    printf '%s' "$arg" > "$WRAPPER_BASE_MARKER"
  fi
  if [ "$previous" = '--branch-label' ]; then printf '%s' "$arg" > "$WRAPPER_LABEL_MARKER"; fi
  previous="$arg"
done
exit 17
`, { mode: 0o755 });
    const marker = join(root, 'base-path');
    const labelMarker = join(root, 'branch-label');
    const result = spawnSync('bash', ['scripts/perf/browser-cold-ab.sh', '--base', 'HEAD', ...(dirtyWorkingTree ? [] : ['--skip-branch-build']), '--fixtures', 'fixture.ifc'], {
      cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WRAPPER_BASE_MARKER: marker, WRAPPER_LABEL_MARKER: labelMarker, WRAPPER_CORRUPT_WASM: corruptServedWasm ? '1' : '0' }, encoding: 'utf8',
    });
    assert.equal(result.status, corruptServedWasm ? 2 : 17, result.stderr);
    if (corruptServedWasm) {
      assert.match(result.stderr, /served viewer WASM differs/);
      assert.equal(existsSync(marker), false, 'mismatched artifacts must not launch the harness');
    } else {
      assert.ok(existsSync(marker), 'child actually received a live base distribution');
      assert.match(readFileSync(labelMarker, 'utf8'), dirtyWorkingTree ? /^[a-f0-9]{40}-dirty$/ : /^supplied-branch-dist$/);
      assert.equal(existsSync(readFileSync(marker, 'utf8')), false, 'temporary base distribution was removed');
    }
    assert.equal(git(['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
