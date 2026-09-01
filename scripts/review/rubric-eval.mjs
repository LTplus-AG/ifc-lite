#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Score a rubric against defects that were REALLY missed.
 *
 * WHY THIS EXISTS. The lane's rubric buys precision with recall on purpose, and
 * measured on live traffic it returned `clean` on six pull requests carrying
 * ELEVEN real findings -- including a Major defect that reopened a hole, and one
 * where the lane's own author had mis-described his design. Changing the rubric
 * to recover that recall is obviously tempting and completely unmeasurable by
 * argument: a prose edit either finds more real defects or invents more noise,
 * and reading the prose cannot tell you which.
 *
 * So this replays diffs whose answer is already known -- CodeRabbit found these,
 * the lane did not -- and reports two numbers a rubric change has to move in the
 * right direction together:
 *
 *   RECALL    of the known findings, how many did this rubric surface?
 *   EXTRA     findings it produced that are NOT in the ground truth.
 *
 * EXTRA IS NOT "FALSE POSITIVES", and calling it that would be the mistake this
 * file has to avoid. CodeRabbit's findings are a floor, not a census: a finding
 * the lane makes that CodeRabbit missed may be perfectly real. So EXTRA is
 * reported as a number to LOOK AT, never as a score to minimise, and the harness
 * prints each one so a human decides. A harness that auto-penalised extras would
 * train the rubric toward silence, which is the failure it exists to fix.
 *
 * IT COSTS SUBSCRIPTION QUOTA. Each case is one model call, so this is
 * `workflow_dispatch` and local, never per-PR. Run it before and after a rubric
 * change, on the same cases, and compare.
 *
 * STATED HOLE: two cases and three known findings is a small sample, and a
 * rubric that improves on these may not improve in general. It is enough to
 * catch a change that makes recall WORSE, which is the direction that matters
 * when the current recall is zero.
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASE_DIR = join(HERE, 'eval-cases');

/**
 * Did the review surface this known finding?
 *
 * Matched on PATH plus any distinctive term from the description, not on exact
 * wording: two reviewers describing the same defect will not phrase it alike,
 * and demanding they do would score paraphrase rather than recall.
 *
 * @returns {{ hit: boolean, by: string|null }}
 */
export function matches(expected, findings) {
  const sameFile = findings.filter((f) => f.path === expected.path);
  if (sameFile.length === 0) return { hit: false, by: null };
  // Distinctive terms, STEMMED to a prefix. Two reviewers describing one defect
  // differ on word FORM as much as on wording -- "case-sensitive" against
  // "sensitively", "disabled" against "disables" -- and an exact-word match
  // scored those as misses, which would have made this harness report a rubric
  // as worse than it is. Seven characters is long enough that a stem is still
  // about this defect: "enforce" is shared by half this repository's prose, which
  // is exactly why TWO distinct stems are required rather than one.
  const terms = [
    ...new Set(
      (expected.what.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) || [])
        .map((t) => t.toLowerCase().slice(0, 7))
        .filter((t) => !['should ', 'because', 'without', 'nothing', 'cannot'].includes(t)),
    ),
  ];
  for (const f of sameFile) {
    const blob = `${f.body ?? ''} ${f.quote ?? ''} ${f.class ?? ''}`.toLowerCase();
    const hits = terms.filter((t) => blob.includes(t));
    if (hits.length >= 2) return { hit: true, by: `${f.path}:${f.line} (${hits.slice(0, 3).join(', ')})` };
  }
  return { hit: false, by: null };
}

/** @returns {{ recall: string, hits: number, total: number, extra: number, lines: string[] }} */
export function score(cases) {
  const lines = [];
  let hits = 0;
  let total = 0;
  let extra = 0;
  for (const c of cases) {
    lines.push(`  PR #${c.pr}: verdict=${c.verdict}, ${c.findings.length} finding(s)`);
    for (const e of c.expected) {
      total += 1;
      const m = matches(e, c.findings);
      if (m.hit) hits += 1;
      lines.push(`    ${m.hit ? '✅ FOUND   ' : '❌ MISSED  '} ${e.path}: ${e.what.slice(0, 88)}`);
      if (m.hit) lines.push(`               via ${m.by}`);
    }
    const matchedPaths = new Set(c.expected.map((e) => e.path));
    const others = c.findings.filter((f) => !matchedPaths.has(f.path));
    extra += others.length;
    for (const o of others) {
      lines.push(`    ➕ EXTRA   ${o.path}:${o.line} ${String(o.body ?? '').slice(0, 70)}`);
    }
  }
  return {
    recall: total === 0 ? 'n/a' : `${hits}/${total} (${Math.round((hits / total) * 100)}%)`,
    hits,
    total,
    extra,
    lines,
  };
}

function main() {
  const rubricArg = process.argv.indexOf('--rubric');
  const rubric = rubricArg === -1 ? join(HERE, 'rubric.md') : process.argv[rubricArg + 1];
  const model = process.env.EVAL_MODEL || 'sonnet';
  const tmp = mkdtempSync(join(tmpdir(), 'rubric-eval-'));

  const files = readdirSync(CASE_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error('No eval cases found; the harness would report a vacuous 0/0.');

  const results = [];
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(CASE_DIR, f), 'utf8'));
    const inputPath = join(tmp, `${f}.input.json`);
    const outPath = join(tmp, `${f}.out.txt`);
    writeFileSync(inputPath, JSON.stringify(c.input));
    const r = spawnSync(
      process.execPath,
      [join(HERE, 'run-reviewer.mjs'), '--rubric', rubric, '--input', inputPath, '--out', outPath, '--model', model],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) {
      // A case that could not run is NOT a case that found nothing. Scoring it as
      // a miss would blame the rubric for a drained pool.
      console.error(`${r.stdout || ''}${r.stderr || ''}`.trim());
      throw new Error(`Case ${f} did not run. The reviewer's own verdict is above; the score is not computable.`);
    }
    const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
    results.push({ pr: c.pr, expected: c.expected, verdict: parsed.verdict, findings: parsed.findings ?? [] });
  }

  const s = score(results);
  console.log(`\nRubric: ${rubric}   model: ${model}`);
  for (const l of s.lines) console.log(l);
  console.log(`\n  RECALL of known findings: ${s.recall}`);
  console.log(`  EXTRA findings (look at these, do not minimise them): ${s.extra}`);
  console.log('\n  Compare against the same command on the other rubric. A change that lowers');
  console.log('  recall is a regression whatever it does to EXTRA.\n');
}

if (process.argv[1] && process.argv[1].endsWith('rubric-eval.mjs')) main();
