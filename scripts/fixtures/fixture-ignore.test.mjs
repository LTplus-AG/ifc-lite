/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cases = text => [...text].reduce((values, letter) => values.flatMap(value =>
  [value + letter.toLowerCase(), value + letter.toUpperCase()]), ['']);

test('Gaussian fixture bytes are ignored in every admitted extension case, only under models (#8580)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ifc-fixture-ignore-'));
  try {
    // Interpret the actual ignore configuration with Git. A clean repository
    // avoids host-local excludes (which can conceal this defect) and ignorecase.
    const init = spawnSync('git', ['init', '--quiet', '--template=', root], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    copyFileSync(new URL('../../.gitignore', import.meta.url), join(root, '.gitignore'));
    const extensions = [...cases('ply'), ...cases('splat')];
    const ignored = extensions.flatMap(ext => ['tests/models', 'tests/models/gaussian', 'tests/models/pointcloud/nested']
      .map(dir => `${dir}/ignore-probe.${ext}`));
    const outside = extensions.flatMap(ext => [`docs/ignore-probe.${ext}`, `tests/other/ignore-probe.${ext}`]);
    const result = spawnSync('git', ['-c', 'core.ignorecase=false', '-c', 'core.excludesFile=/dev/null',
      'check-ignore', '--no-index', '--stdin', '-z'], {
      cwd: root, encoding: 'utf8', input: [...ignored, ...outside].join('\0') + '\0',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split('\0').filter(Boolean).sort(), ignored.sort());
    // No model files were created, read, moved, or removed by this check.
  } finally { rmSync(root, { recursive: true, force: true }); }
});
