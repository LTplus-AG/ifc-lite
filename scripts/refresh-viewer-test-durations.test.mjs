/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REFRESH = join(ROOT, 'scripts/refresh-viewer-test-durations.mjs');

function refresh(t) {
  const root = mkdtempSync(join(tmpdir(), 'viewer-file-timings-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', sha, '--', 'apps/viewer/src/'],
    { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => file.slice('apps/viewer/'.length));
  assert.ok(files.length > 2000, 'use the real viewer inventory');
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.REFRESH_FIXTURE_MODE;
if (args[0] === 'api' && args[1].endsWith('/12345')) {
  console.log(${JSON.stringify(sha)});
} else if (args[0] === 'api' && args.includes('--paginate')) {
  console.log('1001\\tsuccess\\tViewer tests (shard 0)');
  console.log('1002\\tsuccess\\tViewer tests (shard 1)');
} else if (args[0] === 'api' && args.includes('--allow-escape-sequences')) {
  console.log('2026-01-01T00:00:00.000Z   VIEWER_TEST_CONCURRENCY: ' + (mode === 'serial' ? 1 : 2));
} else if (args[0] === 'run' && args[1] === 'download') {
  const root = args[args.indexOf('--dir') + 1];
  const files = ${JSON.stringify(files)};
  const half = Math.floor(files.length / 2);
  const groups = [files.slice(0, half), files.slice(half)];
  if (mode === 'duplicate') groups[1].push(files[0]);
  if (mode === 'missing') groups[1].pop();
  if (mode === 'unexpected') groups[1].push('src/extra.test.ts');
  for (const [shard, group] of groups.entries()) {
    const dir = join(root, 'viewer-file-timings-' + shard);
    mkdirSync(dir);
    const durations = Object.fromEntries(group.map((file) => [file, 0.42]));
    if (mode === 'invalid') durations[group[0]] = null;
    writeFileSync(join(dir, 'viewer-test-file-durations.json'), JSON.stringify(durations));
  }
} else {
  process.stderr.write(JSON.stringify(args));
  process.exitCode = 1;
}
`, { mode: 0o755 });
  return {
    files,
    run: (mode) => spawnSync(process.execPath, [REFRESH, '--concurrent-run', '12345', '--dry-run'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: root + delimiter + process.env.PATH, REFRESH_FIXTURE_MODE: mode },
    }),
  };
}

test('concurrent refresh consumes a complete disjoint timing inventory through the CLI', { skip: process.platform === 'win32' }, (t) => {
  const { files, run } = refresh(t);
  const result = run('complete');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`measured ${files.length} concurrent files in 2 shards`));
});

test('concurrent refresh rejects unusable timing runs through the CLI', { skip: process.platform === 'win32' }, (t) => {
  const { run } = refresh(t);
  for (const [mode, message] of [
    ['duplicate', /duplicate file/],
    ['missing', /recorded \d+\/\d+ files/],
    ['unexpected', /unexpected file/],
    ['invalid', /invalid duration/],
    ['serial', /expected VIEWER_TEST_CONCURRENCY=2/],
  ]) {
    const result = run(mode);
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.match(result.stderr, message);
  }
});
