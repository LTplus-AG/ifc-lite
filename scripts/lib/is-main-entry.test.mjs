/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `isMainEntry` cannot be tested by importing it and calling it: an imported
 * module is never the process entry point, so the interesting answer -- true,
 * for a script node was actually asked to run -- is unreachable from inside
 * the test process. Every case here has to be SPAWNED.
 *
 * The failure this guards is silent in the worst way. A false negative does
 * not throw; the module simply falls through, prints nothing, and exits 0,
 * and a caller reading the status sees a pass. `scripts/release-crates.mjs`
 * would publish no crates and report success.
 */

/** A literal dollar sign, so generated `${...}` never appears in a plain string. */
const DOLLAR = '$';

/** Stage the helper plus a caller that prints its verdict, and return the dir. */
function stage(dirPrefix) {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(
    join(dir, 'lib', 'is-main-entry.mjs'),
    readFileSync(new URL('./is-main-entry.mjs', import.meta.url))
  );
  writeFileSync(
    join(dir, 'caller.mjs'),
    [
      "import { isMainEntry } from './lib/is-main-entry.mjs';",
      // Print BOTH so a failure shows which spelling was consulted. These are
      // assembled with an explicit DOLLAR constant rather than written inline:
      // a plain string containing a literal `${...}` is exactly what
      // no-template-curly-in-string exists to flag, and here it is deliberate
      // -- this is source code being GENERATED, not a template gone wrong.
      `console.log(\`fixed=${DOLLAR}{isMainEntry(import.meta.url)}\`);`,
      `console.log(\`naive=${DOLLAR}{import.meta.url === \`file://${DOLLAR}{process.argv[1]}\`}\`);`,
      '',
    ].join('\n')
  );
  return dir;
}

test('says yes for a plain path, so the check is not vacuously false', () => {
  const dir = stage('ismain-plain-');
  try {
    const run = spawnSync(process.execPath, [join(dir, 'caller.mjs')], { encoding: 'utf8' });
    assert.match(run.stdout, /fixed=true/, `expected fixed=true, got: ${run.stdout}${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('says yes through a path containing a SPACE, where the naive spelling says no', () => {
  // argv[1] carries the raw path; import.meta.url percent-encodes the space.
  // Comparing the two as strings therefore never matches.
  const dir = stage('ismain has space ');
  try {
    assert.ok(dir.includes(' '), `temp dir must contain a space, got ${dir}`);
    const run = spawnSync(process.execPath, [join(dir, 'caller.mjs')], { encoding: 'utf8' });
    assert.match(run.stdout, /fixed=true/, `expected fixed=true, got: ${run.stdout}${run.stderr}`);
    // Pin the bug itself. If this ever reads naive=true the case has stopped
    // being a discriminator, and a regression to the naive spelling would slip
    // through this file unnoticed.
    assert.match(
      run.stdout,
      /naive=false/,
      'the naive spelling passed here, so this test no longer distinguishes it',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('says yes through a SYMLINK, where the naive spelling says no', () => {
  const real = stage('ismain-real-');
  const linkDir = mkdtempSync(join(tmpdir(), 'ismain-link-'));
  const link = join(linkDir, 'linked');
  try {
    symlinkSync(real, link);
    const run = spawnSync(process.execPath, [join(link, 'caller.mjs')], { encoding: 'utf8' });
    assert.match(run.stdout, /fixed=true/, `expected fixed=true, got: ${run.stdout}${run.stderr}`);
    assert.match(
      run.stdout,
      /naive=false/,
      'the naive spelling passed here, so this test no longer distinguishes it',
    );
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('says no when the module is imported rather than run', () => {
  // The other half of the contract: a script imported by a test must NOT run
  // its main(), or importing it for a unit test would publish crates.
  const dir = stage('ismain-import-');
  try {
    writeFileSync(
      join(dir, 'importer.mjs'),
      "import './caller.mjs';\n",
    );
    const run = spawnSync(process.execPath, [join(dir, 'importer.mjs')], { encoding: 'utf8' });
    assert.match(run.stdout, /fixed=false/, `expected fixed=false, got: ${run.stdout}${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
