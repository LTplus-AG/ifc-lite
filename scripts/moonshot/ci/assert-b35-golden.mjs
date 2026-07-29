#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Standing-evidence tripwire for the B3.5 five-act demo
 * (.github/workflows/moonshot.yml, bet B4.1).
 *
 * `scripts/moonshot/b35-demo/run.mjs` writes `demo-report.json` whose entire
 * `deterministic` subtree is a pure function of the master seed (default
 * 20260724) -- act statuses, entity counts, reward channels, node/read
 * counts, merge-battery tallies, carbon numbers, hashes. Wall clocks and the
 * timestamp live ONLY under `volatile`. That makes the deterministic subtree
 * the single densest regression signal in the moonshot program: one number
 * moving anywhere across world-gym, @ifc-lite/create, @ifc-lite/provenance,
 * the benchmark scorer or the geometry kernel shows up here.
 *
 * This script asserts that subtree BYTE-FOR-BYTE against the committed
 * golden at `scripts/moonshot/ci/b35-golden.json`, and on a mismatch names
 * the JSON paths that moved so a red run is diagnosable from the step log
 * alone.
 *
 * Note the demo REWRITES `scripts/moonshot/b35-demo/demo-report.json` in
 * place on every run, so that file cannot be its own baseline -- hence a
 * separate, explicitly-named golden.
 *
 * Sensitivity, measured rather than assumed. The report rounds (carbon to 3
 * decimals, parameters to 6), so this is not an ULP-level tripwire: a
 * one-ULP nudge of a carbon factor (315 -> 315.00000000000006) does NOT
 * move it. What does, verified by injection:
 *   - a 3e-9 relative change to a carbon factor (315 -> 315.000001) ->
 *     names acts/act5/data/params/* and the carbon fields;
 *   - a 1e-6 relative change to extrusion depth in rust/geometry ->
 *     names acts/act5/data/kernelValidation/* (kernelCarbonKg,
 *     worstElementRelDev, carbonRelDev), i.e. it catches a wasm geometry
 *     kernel change through the act-5 re-measurement.
 * The floor is the report's own rounding, and act 5's kernel-validation
 * block is the most sensitive part of it.
 *
 * SELF-TEST. `--self-test` tests the test: it injects a known perturbation,
 * proves this script goes red and names act 5 and the moved paths, restores
 * the tree and proves it goes green again. See selfTest() below for the
 * mechanics and for why the perturbation has the magnitude it has. It exists
 * because the G4 review (docs/vision/reviews/g4-red-team-2026-07-29.md
 * section 4) found that the perturbation half of B4.1's exam was attested in
 * prose and had no committed artifact: a tripwire nobody ever fires is
 * indistinguishable from a tripwire that cannot fire.
 *
 * Usage:
 *   node scripts/moonshot/ci/assert-b35-golden.mjs             # assert
 *   node scripts/moonshot/ci/assert-b35-golden.mjs --update    # re-bless
 *   node scripts/moonshot/ci/assert-b35-golden.mjs --self-test # prove it fires
 *
 * Exit codes: 0 match, 1 drift, 2 usage/IO problem.
 * Under --self-test: 0 the tripwire fired and recovered, 1 it did not (or the
 * tree was not restored), 2 usage/IO problem.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const REPORT_PATH = path.join(REPO_ROOT, 'scripts/moonshot/b35-demo/demo-report.json');
const GOLDEN_PATH = path.join(HERE, 'b35-golden.json');

const UPDATE = process.argv.includes('--update');
const SELF_TEST = process.argv.includes('--self-test');

if (UPDATE && SELF_TEST) {
  console.error('::error::--update and --self-test are mutually exclusive.');
  console.error('--self-test asserts the CURRENT golden is the right reference; --update replaces it.');
  process.exit(2);
}

/** Serialize exactly the way run.mjs serializes demo-report.json. */
function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    console.error(`::error::${what} not found at ${path.relative(REPO_ROOT, file)}: ${err.message}`);
    if (file === REPORT_PATH) {
      console.error('Run `node scripts/moonshot/b35-demo/run.mjs` first -- it writes the report this script checks.');
    } else {
      console.error('Re-bless with `node scripts/moonshot/ci/assert-b35-golden.mjs --update`.');
    }
    process.exit(2);
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (err) {
    console.error(`::error::${what} at ${path.relative(REPO_ROOT, file)} is not valid JSON: ${err.message}`);
    process.exit(2);
  }
}

/** Every leaf path where `a` and `b` disagree, as `a/b/c` strings. */
function diffPaths(a, b, prefix = '', out = []) {
  if (out.length >= 40) return out;
  const bothObjects =
    a !== null && b !== null && typeof a === 'object' && typeof b === 'object' &&
    Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ path: prefix || '(root)', golden: a, actual: b });
    }
    return out;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    diffPaths(a[k], b[k], prefix ? `${prefix}/${k}` : k, out);
    if (out.length >= 40) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// --self-test: fire the tripwire on purpose, then put everything back.
// ---------------------------------------------------------------------------

const DEMO_RUN = path.join(REPO_ROOT, 'scripts/moonshot/b35-demo/run.mjs');
const REPORT_MD_PATH = path.join(REPO_ROOT, 'scripts/moonshot/b35-demo/demo-report.md');
const CARBON_MODEL_PATH = path.join(REPO_ROOT, 'scripts/moonshot/diff-spike/carbon-model.mjs');

/**
 * The injection site and its magnitude.
 *
 * WHERE. `CARBON_FACTORS.Concrete` in scripts/moonshot/diff-spike/carbon-model.mjs.
 * It reaches the golden's kernel-validation block by a path that is provable
 * by reading two lines rather than by trusting a measurement:
 * scripts/moonshot/b35-demo/act5-descent.mjs imports CARBON_FACTORS and
 * accumulates `kernelCarbon += row.kernelVolume * factor` over the volumes the
 * wasm geometry kernel re-measured, then emits it as
 * `acts/act5/data/kernelValidation/kernelCarbonKg` (and, via
 * `|kernelCarbon - n.carbon| / n.carbon`, as `carbonRelDev`). So a change to
 * this constant MUST move the kernel-validation fields unless the pipeline
 * from the kernel to the golden is broken -- which is exactly the failure the
 * self-test is here to detect. It is also the same constant the bet's own
 * prose claims was perturbed, so this script now evidences that claim rather
 * than restating it.
 *
 * WHY 1e-6 RELATIVE (315 -> 315.000315). The tripwire's floor is the report's
 * own rounding, not machine epsilon. `kernelCarbonKg` is rounded to 3 decimals
 * on a ~73,459 kg total, so the smallest change that can survive serialization
 * is ~7e-9 relative on that total; a one-ULP nudge (315.00000000000006)
 * provably does NOT move the golden and would make this a self-test that
 * fails for the wrong reason. The documented, measured floor is ~3e-9 relative
 * on this constant. 1e-6 sits ~300x above that floor and ~140x above the
 * rounding limit, which buys the assertion a margin no plausible re-blessing
 * of the golden can eat, while staying far too small to be mistaken for a
 * deliberate model change by anyone reading the diff. The magnitude is chosen
 * for reliability of the tripwire test; it is NOT a claim about sensitivity.
 * The sensitivity claim remains the measured ~3e-9 stated in the header.
 */
const PERTURB_FIND = '  Concrete: 315,';
const PERTURB_REPLACE = '  Concrete: 315.000315,';
const PERTURB_DESC =
  'CARBON_FACTORS.Concrete 315 -> 315.000315 (+1e-6 relative) in scripts/moonshot/diff-spike/carbon-model.mjs';

/** Files --self-test rewrites. Every one of them is restored byte-for-byte. */
const TOUCHED = [
  'scripts/moonshot/diff-spike/carbon-model.mjs',
  'scripts/moonshot/b35-demo/demo-report.json',
  'scripts/moonshot/b35-demo/demo-report.md',
];

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8' });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** `git status --porcelain` restricted to the files this mode rewrites. */
function touchedStatus() {
  const r = git(['status', '--porcelain', '--', ...TOUCHED]);
  if (r.code !== 0) return null; // not a git checkout (e.g. a tarball) -- handled by the caller
  return r.out;
}

function runNode(scriptPath, args = []) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    // The demo prints a lot; 64 MB is far more than either child produces.
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ms: Date.now() - started,
  };
}

/**
 * The `  <path>` lines from the assert's differing-paths block, and only from
 * there: collection starts at the "N differing path(s)" header and stops at
 * the blank line that closes the block, so the trailing legend and the
 * re-bless instructions can never be mistaken for JSON paths.
 */
function parseDiffPaths(stderr) {
  const out = [];
  let inBlock = false;
  for (const line of stderr.split('\n')) {
    if (!inBlock) {
      if (/^\d+\+? differing path\(s\)/.test(line)) inBlock = true;
      continue;
    }
    if (line.trim() === '') break;
    const m = /^ {2}(\S+)$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function selfTest() {
  const log = [];
  const say = (s = '') => {
    log.push(s);
    console.log(s);
  };
  const fail = (s) => {
    log.push(s);
    console.error(s);
  };

  say('B3.5 golden tripwire --self-test');
  say(`  perturbation: ${PERTURB_DESC}`);
  say(`  assert under test: ${path.relative(REPO_ROOT, fileURLToPath(import.meta.url))}`);
  say('');

  // Baseline for the restore proof. NOT required to be empty: in the CI lane
  // this step runs after E3a, which legitimately rewrites demo-report.{json,md}
  // with fresh `volatile` wall clocks, so demanding a pristine tree would make
  // the step unusable exactly where it matters. What IS required is that the
  // status is byte-identical afterwards -- the snapshot/restore is over file
  // CONTENT, so restoring a pre-modified file reproduces its modification too.
  // A pre-existing modification is reported rather than swallowed, because
  // evidence taken from a modified tree is weaker evidence.
  const before = touchedStatus();
  if (before === null) {
    console.error('::error::--self-test needs a git checkout: it verifies the tree is restored with `git status`.');
    process.exit(2);
  }
  if (before !== '') {
    say('NOTE: these files were already modified before the self-test started;');
    say('      they are snapshotted and put back exactly as found:');
    for (const line of before.split('\n')) say(`      ${line}`);
    say('');
  }

  // Snapshot as bytes rather than trusting `git checkout --` to undo things:
  // the restore must work even if the perturbation crashed something that
  // left git in a state we did not anticipate.
  const snapshot = new Map();
  for (const rel of TOUCHED) {
    const abs = path.join(REPO_ROOT, rel);
    try {
      snapshot.set(abs, readFileSync(abs));
    } catch (err) {
      console.error(`::error::cannot snapshot ${rel}: ${err.message}`);
      process.exit(2);
    }
  }
  // Deliberately NOT latched: it must be safe (and effective) to call more
  // than once. Stage B re-runs the demo AFTER restoring, and that run rewrites
  // demo-report.{json,md} with fresh `volatile` wall clocks -- so the final
  // restore in the `finally` is the one that actually leaves the tree clean.
  const restore = () => {
    for (const [abs, bytes] of snapshot) writeFileSync(abs, bytes);
  };
  // try/finally covers throws; these cover Ctrl-C and a CI cancellation.
  const onSignal = (sig) => {
    restore();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const problems = [];
  let stageA = null;
  let stageB = null;
  let capturedFailure = '';

  try {
    // --- Stage A: perturb, re-run the demo, expect the tripwire to fire ----
    const original = readFileSync(CARBON_MODEL_PATH, 'utf-8');
    const hits = original.split(PERTURB_FIND).length - 1;
    if (hits !== 1) {
      fail(`::error::injection anchor ${JSON.stringify(PERTURB_FIND)} occurs ${hits} time(s) in`);
      fail(`  ${path.relative(REPO_ROOT, CARBON_MODEL_PATH)} -- expected exactly 1.`);
      fail('  The carbon model moved; re-point PERTURB_FIND rather than weakening the match.');
      restore();
      process.exit(2);
    }
    writeFileSync(CARBON_MODEL_PATH, original.replace(PERTURB_FIND, PERTURB_REPLACE), 'utf-8');
    say('stage A -- perturbation injected, re-running the five-act demo');

    const demoA = runNode(DEMO_RUN);
    if (demoA.code !== 0) {
      // A perturbation that makes the demo throw proves nothing about the
      // golden: it never got as far as writing a report to compare.
      fail(`::error::stage A: the demo exited ${demoA.code} under the perturbation instead of completing.`);
      fail('The self-test needs the demo to RUN and produce a different number, not to crash.');
      fail(demoA.stderr.split('\n').slice(-25).join('\n'));
      problems.push('stage A: demo did not complete under the perturbation');
    } else {
      say(`  demo completed in ${(demoA.ms / 1000).toFixed(1)}s`);
      const assertA = runNode(fileURLToPath(import.meta.url));
      stageA = assertA;
      capturedFailure = assertA.stderr;
      say(`  golden check exited ${assertA.code} in ${(assertA.ms / 1000).toFixed(1)}s (expected 1 = drift)`);

      if (assertA.code === 0) {
        problems.push(
          'THE TRIPWIRE DID NOT FIRE: the golden check passed with a perturbed carbon factor. ' +
            'A >=1e-6 relative change reached no pinned field -- the golden no longer covers ' +
            "act 5's kernel-validation block, or the demo is not reading the perturbed source.",
        );
      } else if (assertA.code !== 1) {
        problems.push(
          `the golden check exited ${assertA.code} (usage/IO), not 1 (drift) -- it failed for the wrong reason`,
        );
      }
      if (!assertA.stderr.includes('B3.5 DETERMINISTIC DRIFT')) {
        problems.push('the failure output does not carry the "B3.5 DETERMINISTIC DRIFT" banner');
      }

      const paths = parseDiffPaths(assertA.stderr);
      const act5 = paths.filter((p) => p.startsWith('acts/act5/'));
      const other = paths.filter((p) => !p.startsWith('acts/act5/'));
      const kernel = paths.filter((p) => p.startsWith('acts/act5/data/kernelValidation/'));
      say(`  differing paths named: ${paths.length} (act 5: ${act5.length}, kernel-validation: ${kernel.length})`);

      if (act5.length === 0) {
        problems.push('the failure names no acts/act5/* path -- "names which act broke" is not met');
      }
      if (!kernel.includes('acts/act5/data/kernelValidation/kernelCarbonKg')) {
        problems.push(
          'acts/act5/data/kernelValidation/kernelCarbonKg did not move, although the perturbed ' +
            'constant is multiplied into it by act5-descent.mjs -- the kernel measurement is no ' +
            'longer reaching the golden',
        );
      }
      if (other.length > 0) {
        // Deterministic, so this cannot go flaky: the perturbed constant is
        // imported only by act 5. Anything else moving is a real finding.
        problems.push(
          `${other.length} path(s) outside act 5 moved under an act-5-only perturbation: ${other.join(', ')}`,
        );
      }
    }

    // --- Stage B: restore, re-run, expect green again ---------------------
    say('');
    say('stage B -- original state restored, re-running to prove recovery');
    restore();
    const demoB = runNode(DEMO_RUN);
    if (demoB.code !== 0) {
      fail(`::error::stage B: the demo exited ${demoB.code} after restore.`);
      fail(demoB.stderr.split('\n').slice(-25).join('\n'));
      problems.push('stage B: demo did not complete after restore');
    } else {
      say(`  demo completed in ${(demoB.ms / 1000).toFixed(1)}s`);
      const assertB = runNode(fileURLToPath(import.meta.url));
      stageB = assertB;
      say(`  golden check exited ${assertB.code} in ${(assertB.ms / 1000).toFixed(1)}s (expected 0 = match)`);
      if (assertB.code !== 0) {
        problems.push(
          'the golden check is still red after the perturbation was reverted. Either the restore ' +
            'is incomplete, or the tree was ALREADY drifting before this self-test ran -- in which ' +
            "case stage A's red proves nothing.",
        );
        fail(assertB.stderr.split('\n').slice(0, 30).join('\n'));
      }
    }
  } finally {
    restore();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  // --- The restore has to be provable, not asserted ------------------------
  const after = touchedStatus();
  say('');
  if (after === null) {
    problems.push('could not run `git status` to verify the tree was restored');
  } else if (after !== before) {
    problems.push(
      `the tree was NOT restored to its starting state.\n` +
        `  before: ${JSON.stringify(before)}\n` +
        `  after:  ${JSON.stringify(after)}`,
    );
  } else if (after === '') {
    say(`tree restored: \`git status --porcelain\` clean over all ${TOUCHED.length} touched files.`);
  } else {
    say(`tree restored: \`git status --porcelain\` identical to the pre-run baseline over all ${TOUCHED.length} touched files.`);
  }

  say('');
  if (problems.length > 0) {
    console.error('::error::B3.5 GOLDEN SELF-TEST FAILED -- the tripwire cannot be trusted.');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  say('SELF-TEST PASS: the B3.5 golden tripwire fires on a 1e-6 relative carbon-factor');
  say('perturbation, names act 5 and its kernel-validation fields, and returns to green');
  say('when the perturbation is reverted.');
  say('');
  say('--- captured failure output (stage A) ---');
  const captured = capturedFailure.trimEnd();
  console.log(captured);
  log.push(captured);

  // A machine-readable tail so a future evidence refresh can diff two runs.
  const summary = {
    perturbation: PERTURB_DESC,
    stageAExit: stageA?.code ?? null,
    stageBExit: stageB?.code ?? null,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  say('');
  say(`summary: ${JSON.stringify(summary)}`);
  process.exit(0);
}

if (SELF_TEST) selfTest();

const report = readJson(REPORT_PATH, 'B3.5 demo report').value;
if (!report || typeof report !== 'object' || typeof report.deterministic !== 'object' || report.deterministic === null) {
  console.error(`::error::${path.relative(REPO_ROOT, REPORT_PATH)} has no \`deterministic\` object -- the report shape changed.`);
  process.exit(2);
}
const actualText = serialize(report.deterministic);

if (UPDATE) {
  writeFileSync(GOLDEN_PATH, actualText, 'utf-8');
  console.log(`golden updated: ${path.relative(REPO_ROOT, GOLDEN_PATH)} (${actualText.length} bytes)`);
  console.log(`source report:  ${path.relative(REPO_ROOT, REPORT_PATH)} (masterSeed ${report.deterministic.masterSeed})`);
  process.exit(0);
}

const golden = readJson(GOLDEN_PATH, 'B3.5 golden');

if (golden.text === actualText) {
  const acts = Object.entries(report.deterministic.acts ?? {})
    .map(([k, v]) => `${k}=${v.status}`)
    .join(' ');
  console.log(
    `B3.5 deterministic subtree matches the golden byte-for-byte ` +
      `(${actualText.length} bytes, masterSeed ${report.deterministic.masterSeed}, config ` +
      `${JSON.stringify(report.deterministic.config)}).`,
  );
  console.log(`acts: ${acts}`);
  process.exit(0);
}

const diffs = diffPaths(golden.value, report.deterministic);
console.error(
  '::error::B3.5 DETERMINISTIC DRIFT -- the five-act demo no longer reproduces its seeded golden.',
);
console.error('');
console.error(`golden: ${path.relative(REPO_ROOT, GOLDEN_PATH)} (${golden.text.length} bytes)`);
console.error(`actual: ${path.relative(REPO_ROOT, REPORT_PATH)} -> deterministic (${actualText.length} bytes)`);
console.error('');
if (diffs.length === 0) {
  console.error('No value-level difference found -- the two serialize differently only in key order or');
  console.error('formatting, i.e. the report SHAPE changed rather than any measured number.');
} else {
  console.error(`${diffs.length}${diffs.length >= 40 ? '+' : ''} differing path(s), golden -> actual:`);
  for (const d of diffs) {
    console.error(`  ${d.path}`);
    console.error(`      golden: ${JSON.stringify(d.golden)}`);
    console.error(`      actual: ${JSON.stringify(d.actual)}`);
  }
}
console.error('');
console.error('The leading path segment names the act that broke:');
console.error('  acts/act1 = BIRTH       world-gym generator/labeler/reward channels');
console.error('  acts/act2 = PROOF       node-hash-v0 DAG + certificate verify/tamper (@ifc-lite/provenance)');
console.error('  acts/act3 = SABOTAGE    benchmark splits/ground-truth/scorer');
console.error('  acts/act4 = CONVERGENCE merge battery + commutation certificates');
console.error('  acts/act5 = DESCENT     differentiable carbon model + GEOMETRY KERNEL re-measurement');
console.error('');
console.error('If the change is intended, re-run the demo and re-bless with:');
console.error('  node scripts/moonshot/b35-demo/run.mjs');
console.error('  node scripts/moonshot/ci/assert-b35-golden.mjs --update');
console.error('and commit both the golden and scripts/moonshot/b35-demo/demo-report.{json,md}.');
process.exit(1);
