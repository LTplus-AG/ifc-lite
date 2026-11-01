/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('#8525: normalize actual Node JUnit without losing failures, skips or nested suites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-junit-'));
  try {
    const fixture = join(dir, 'fixture.mjs');
    const report = join(dir, 'report.xml');
    writeFileSync(fixture, `import { test, describe } from 'node:test';
      test('pass', () => {});
      test('fail', () => { throw new Error('expected failure'); });
      test.skip('skip', () => {});
      describe('nested', () => { test('nested pass', () => {}); });`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
      '--test-reporter-destination=stdout', '--test-reporter=junit',
      `--test-reporter-destination=${report}`, fixture], { env });
    assert.equal(run.status, 1);
    const helper = resolve('scripts/normalize-node-junit.py');
    assert.equal(spawnSync('python3', [helper, report]).status, 0);
    const verify = spawnSync('python3', ['-c', `import xml.etree.ElementTree as E, sys
r=E.parse(sys.argv[1]).getroot()
assert r.find('testcase') is None
assert len(r.findall('.//testcase')) == 4
assert len(r.findall('.//failure')) == 1
assert len(r.findall('.//skipped')) == 1
assert r.find('testsuite') is not None`, report], { encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
    const before = readFileSync(report, 'utf8');
    assert.equal(spawnSync('python3', [helper, report]).status, 0);
    assert.equal(readFileSync(report, 'utf8'), before);
    writeFileSync(report, '');
    assert.notEqual(spawnSync('python3', [helper, report]).status, 0);
    assert.notEqual(spawnSync('python3', [helper, join(dir, 'missing.xml')]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
