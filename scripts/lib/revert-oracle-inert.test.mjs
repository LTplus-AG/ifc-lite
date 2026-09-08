/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4137, end to end: the oracle's own verdicts on diffs containing inert files,
 * driven through `check-test-revert-oracle.mjs --root <scratch repo>` against
 * real git, exactly the way CI invokes it.
 *
 * The oracle is an instrument, so each verdict is exercised against a known
 * answer in BOTH directions rather than only the one the fix makes green:
 * assets alone go NOT APPLICABLE, and the same run with one `.rs` added still
 * ABORTs. Every case asserts the verdict line AND the process exit code,
 * because `--ci` maps them separately and a message can be right while the
 * code that blocks the push is wrong.
 *
 * Unit-level coverage of the classification rule itself is in
 * `revert-oracle-classify.test.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const oracle = resolve(dirname(fileURLToPath(import.meta.url)), '../check-test-revert-oracle.mjs');

/**
 * A real PNG header. The NUL bytes are the point: git's own binary detection
 * is what the `inert` rule reads, so the fixture has to be something git
 * genuinely refuses to diff as text, not a file merely named `.png`.
 */
const pngBytes = (seed) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, seed]);

function scratchRepo(name) {
  const root = mkdtempSync(join(tmpdir(), `oracle-inert-${name}-`));
  const env = { ...process.env };
  // The oracle spawns its own Node test run; this runner's IPC must not leak in.
  delete env.NODE_TEST_CONTEXT;
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q');
  git('config', 'user.name', 'Revert oracle fixture');
  git('config', 'user.email', 'oracle@example.invalid');
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD').trim();
  };
  /** Run the oracle the way CI does and hand back BOTH halves of its answer. */
  const runOracle = (base) => {
    const r = spawnSync(process.execPath, [oracle, '--root', root, '--base', base, '--ci'], {
      cwd: root, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(r.error, undefined, r.error?.message);
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  return { root, git, commit, runOracle, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** The repo shape shared by the cases that need a runner: root scripts/*.test.mjs. */
function seedRunnableRepo(repo) {
  for (const dir of ['src', 'scripts']) mkdirSync(join(repo.root, dir), { recursive: true });
  writeFileSync(join(repo.root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'turbo test' } }));
  writeFileSync(join(repo.root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(repo.root, 'scripts/value.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('observes production', () => assert.equal(value, 1));\n");
}

test('#4137 case 1: a diff of only changed PNGs is NOT APPLICABLE, not a finding', { timeout: 60_000 }, () => {
  const repo = scratchRepo('png-modified');
  try {
    mkdirSync(join(repo.root, 'assets'));
    for (let i = 0; i < 5; i++) writeFileSync(join(repo.root, `assets/logo-${i}.png`), pngBytes(i));
    const base = repo.commit('control');
    for (let i = 0; i < 5; i++) writeFileSync(join(repo.root, `assets/logo-${i}.png`), pngBytes(i + 40));
    repo.commit('recolour every logo');

    const { status, output } = repo.runOracle(base);
    assert.match(output, /NOT APPLICABLE/, output);
    assert.match(output, /files: 0 production, 0 test, 0 ignored, 5 inert/, output);
    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /ABORT/, output);
  } finally {
    repo.dispose();
  }
});

test('#4137 case 2: a diff of only DELETED PNGs is NOT APPLICABLE (#4114\'s shape)', { timeout: 60_000 }, () => {
  const repo = scratchRepo('png-deleted');
  try {
    mkdirSync(join(repo.root, 'assets'));
    // A committed source file the deletion does not touch: it must not be
    // dragged into the diff and turn this into a production change by accident.
    writeFileSync(join(repo.root, 'keep.mjs'), 'export const keep = 1;\n');
    for (let i = 0; i < 5; i++) writeFileSync(join(repo.root, `assets/unreferenced-${i}.png`), pngBytes(i));
    const base = repo.commit('control');
    for (let i = 0; i < 5; i++) rmSync(join(repo.root, `assets/unreferenced-${i}.png`));
    repo.commit('delete five unreferenced PNGs');

    const { status, output } = repo.runOracle(base);
    assert.match(output, /NOT APPLICABLE/, output);
    assert.match(output, /files: 0 production, 0 test, 0 ignored, 5 inert/, output);
    assert.match(output, /inert: assets\/unreferenced-0\.png/, output);
    assert.equal(status, 0, output);
  } finally {
    repo.dispose();
  }
});

test('#4137 case 3: a changed .rs with no test STILL aborts — the fix narrows the abort, it does not remove it', { timeout: 60_000 }, () => {
  const repo = scratchRepo('rs-only');
  try {
    mkdirSync(join(repo.root, 'src'));
    writeFileSync(join(repo.root, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(repo.root, 'src/lib.rs'), 'pub fn value() -> u32 { 1 }\n');
    const base = repo.commit('control');
    writeFileSync(join(repo.root, 'src/lib.rs'), 'pub fn value() -> u32 { 2 }\n');
    repo.commit('change production Rust, ship no test');

    const { status, output } = repo.runOracle(base);
    assert.match(output, /ABORT: this branch changes production code and adds\/changes NO test file/, output);
    assert.match(output, /files: 1 production, 0 test, 0 ignored, 0 inert/, output);
    assert.equal(status, 1, output);
    assert.doesNotMatch(output, /NOT APPLICABLE/, output);
  } finally {
    repo.dispose();
  }
});

test('#4137 case 4: a changed .rs PLUS a PNG still aborts, and names only the .rs', { timeout: 60_000 }, () => {
  const repo = scratchRepo('rs-and-png');
  try {
    mkdirSync(join(repo.root, 'src'));
    mkdirSync(join(repo.root, 'assets'));
    writeFileSync(join(repo.root, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(repo.root, 'src/lib.rs'), 'pub fn value() -> u32 { 1 }\n');
    writeFileSync(join(repo.root, 'assets/logo.png'), pngBytes(1));
    const base = repo.commit('control');
    writeFileSync(join(repo.root, 'src/lib.rs'), 'pub fn value() -> u32 { 2 }\n');
    writeFileSync(join(repo.root, 'assets/logo.png'), pngBytes(9));
    repo.commit('change production Rust and an asset, ship no test');

    const { status, output } = repo.runOracle(base);
    assert.match(output, /ABORT: this branch changes production code and adds\/changes NO test file/, output);
    assert.match(output, /files: 1 production, 0 test, 0 ignored, 1 inert/, output);
    assert.equal(status, 1, output);
    // The abort enumerates the changed production files. The PNG is not one of
    // them, and must not appear in the list the author is asked to answer for.
    assert.match(output, /changed: src\/lib\.rs/, output);
    assert.doesNotMatch(output, /changed: assets\/logo\.png/, output);
  } finally {
    repo.dispose();
  }
});

test('#4137 case 5: a real production+test pair plus an unrelated PNG takes the normal OBSERVED path', { timeout: 90_000 }, () => {
  const repo = scratchRepo('observed-with-png');
  try {
    seedRunnableRepo(repo);
    mkdirSync(join(repo.root, 'assets'));
    writeFileSync(join(repo.root, 'assets/logo.png'), pngBytes(1));
    const base = repo.commit('control');
    writeFileSync(join(repo.root, 'src/value.mjs'), 'export const value = 2;\n');
    writeFileSync(join(repo.root, 'scripts/value.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('observes production', () => assert.equal(value, 2));\n");
    writeFileSync(join(repo.root, 'assets/logo.png'), pngBytes(9));
    repo.commit('change production, its test, and an unrelated asset');

    const { status, output } = repo.runOracle(base);
    assert.match(output, /OBSERVED/, output);
    assert.match(output, /1 assertion\(s\) RED out of 1 collected/, output);
    assert.match(output, /files: 1 production, 1 test, 0 ignored, 1 inert/, output);
    assert.equal(status, 0, output);
    // The asset is sidelined, never reverted: the OBSERVED is earned by the
    // production file alone, which is why the multi-file NOTE must stay absent.
    assert.match(output, /reverted: src\/value\.mjs/, output);
    assert.doesNotMatch(output, /reverted: assets\/logo\.png/, output);
    assert.equal(repo.git('status', '--porcelain').trim(), '');
  } finally {
    repo.dispose();
  }
});

test('#4137 case 6: a test-only diff is still NOT APPLICABLE (regression guard for #4024)', { timeout: 60_000 }, () => {
  const repo = scratchRepo('test-only');
  try {
    seedRunnableRepo(repo);
    const base = repo.commit('control');
    writeFileSync(join(repo.root, 'scripts/value.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('observes production', () => assert.equal(value, 1));\ntest('and its type', () => assert.equal(typeof value, 'number'));\n");
    repo.commit('add one assertion, touch nothing else');

    const { status, output } = repo.runOracle(base);
    assert.match(output, /NOT APPLICABLE/, output);
    assert.match(output, /files: 0 production, 1 test, 0 ignored, 0 inert/, output);
    // The message must still be the "no production files" one, not the inert
    // one: this branch has no inert file at all.
    assert.match(output, /changes no production files/, output);
    assert.equal(status, 0, output);
  } finally {
    repo.dispose();
  }
});

test('#4137 case 7: a `.gitattributes` `-diff` TEXT file is NOT inert and still aborts', { timeout: 60_000 }, () => {
  // git reports `-`/`-` in numstat for three different reasons and only one of
  // them is about the content. This repo turns diffing OFF for its playground
  // samples, so reading numstat alone classifies four committed STEP text
  // files as inert — files that ~20 tests read byte-for-byte, among them
  // rust/geometry/tests/clash_intersection_real_model.rs (infra-bridge),
  // rust/processing/tests/instancing_dont_bake.rs (hello-wall) and
  // packages/cli/src/commands/export-usd.test.ts. The fixture carries this
  // repo's REAL attribute line and REAL sample path so a future edit to either
  // one cannot quietly re-open the hole.
  const repo = scratchRepo('gitattributes-nodiff');
  const sample = 'apps/viewer/public/samples/hello-wall.ifc';
  try {
    mkdirSync(join(repo.root, 'apps/viewer/public/samples'), { recursive: true });
    mkdirSync(join(repo.root, 'assets'));
    writeFileSync(join(repo.root, '.gitattributes'), 'apps/viewer/public/samples/**/*.ifc -filter -diff -merge text\n');
    writeFileSync(join(repo.root, sample), "ISO-10303-21;\nDATA;\n#1=IFCWALL('a');\nENDSEC;\n");
    writeFileSync(join(repo.root, 'assets/logo.png'), pngBytes(1));
    const base = repo.commit('control');
    writeFileSync(join(repo.root, sample), "ISO-10303-21;\nDATA;\n#1=IFCWALL('a');\n#2=IFCWALL('b');\nENDSEC;\n");
    writeFileSync(join(repo.root, 'assets/logo.png'), pngBytes(9));
    repo.commit('edit a -diff sample and a real PNG, ship no test');

    // The fixture must actually exhibit the condition, or this test passes for
    // the wrong reason: git has to report the TEXT sample as undiffable.
    const numstat = repo.git('diff', '--numstat', '--no-renames', base, 'HEAD');
    assert.match(numstat, new RegExp(`-\\t-\\t${sample.replace(/[.]/g, '\\.')}`), numstat);

    const { status, output } = repo.runOracle(base);
    assert.match(output, /ABORT: this branch changes production code and adds\/changes NO test file/, output);
    assert.match(output, /files: 1 production, 0 test, 0 ignored, 1 inert/, output);
    assert.equal(status, 1, output);
    // The text sample is the production file; the PNG beside it is still inert,
    // so the check-attr filter narrows the evidence rather than disabling it.
    assert.match(output, new RegExp(`changed: ${sample.replace(/[.]/g, '\\.')}`), output);
    assert.match(output, /inert: assets\/logo\.png/, output);
  } finally {
    repo.dispose();
  }
});
