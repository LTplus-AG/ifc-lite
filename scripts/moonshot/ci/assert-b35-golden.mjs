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
 * Usage:
 *   node scripts/moonshot/ci/assert-b35-golden.mjs            # assert
 *   node scripts/moonshot/ci/assert-b35-golden.mjs --update   # re-bless
 *
 * Exit codes: 0 match, 1 drift, 2 usage/IO problem.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const REPORT_PATH = path.join(REPO_ROOT, 'scripts/moonshot/b35-demo/demo-report.json');
const GOLDEN_PATH = path.join(HERE, 'b35-golden.json');

const UPDATE = process.argv.includes('--update');

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
