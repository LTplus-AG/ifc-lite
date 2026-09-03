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
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPack, retrievalFailed, retrievalFailedMessage } from './build-context-pack.mjs';
import { MAX_POSTED_FINDINGS } from './post-review.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASE_DIR = join(HERE, 'eval-cases');

/**
 * Which side a non-zero validator exit blames.
 *
 * The REVIEWER's fault: it answered with malformed JSON, said nothing, ran out
 * of tokens, contradicted itself, skipped the proof of work, or quoted lines
 * that are not in the diff so every finding was dropped. The lane POSTS nothing
 * in each of those cases, so the honest score is zero findings for that PR.
 * Aborting instead throws away every other case and reports a broken
 * instrument -- the exact confusion between absence and failure that this
 * pipeline exists to keep apart, and the first version of this split made it
 * for four of the seven, including the two most likely on a real corpus.
 *
 * The INSTRUMENT's fault: the harness fed the validator something wrong, or
 * could not write its output. RAW_UNREADABLE and RAW_EMPTY sit here even though
 * their remedies talk about the model, and for the same reason:
 * `run-reviewer.mjs` throws EMPTY_RESPONSE and exits non-zero before it writes,
 * so the case is already refused as "did not run" upstream. If the validator
 * ever does see a missing or blank raw file, the plumbing broke rather than the
 * model, and aborting is the conservative direction anyway. Putting RAW_EMPTY
 * on the reviewer side contradicted that reasoning while sitting four lines
 * from it. Nothing about the rubric can be read off such a
 * run, so it stops.
 *
 * A reason in NEITHER set stops the run too. Both sets are written out here --
 * the classification is this harness's policy, not the validator's -- and they
 * are held to `REASONS`, which validate-findings.mjs exports, by a test that
 * requires every reason to be classified exactly once. So a reason added there
 * cannot be silently scored as "the reviewer found nothing".
 */
export const REVIEWER_FAULT = new Set([
  'RAW_UNPARSEABLE',
  'RESPONSE_TRUNCATED',
  'SCHEMA_INVALID',
  'VERDICT_CONTRADICTS_FINDINGS',
  'PROOF_OF_WORK_FAILED',
  'VALIDATION_EMPTY',
]);

export const INSTRUMENT_FAULT = new Set([
  'BAD_ARGS',
  'NO_RAW',
  'NO_INPUT',
  'NO_OUT',
  'RAW_UNREADABLE',
  'RAW_EMPTY',
  'INPUT_UNREADABLE',
  'INPUT_INVALID',
  'OUT_UNWRITABLE',
]);

export function validatorReason(said) {
  // [A-Z0-9_] to match the reason alphabet. Narrower here, a reason with a
  // digit parsed as null at run time while the guard test happily classified it
  // -- the eval would abort every case blaming the harness, with green tests.
  return /(?:^|\n)\u274c ([A-Z0-9_]+):/.exec(String(said))?.[1] ?? null;
}


/**
 * Did the review surface this known finding?
 *
 * Matched on PATH plus any distinctive term from the description, not on exact
 * wording: two reviewers describing the same defect will not phrase it alike,
 * and demanding they do would score paraphrase rather than recall.
 *
 * @returns {{ hit: boolean, by: string|null }}
 */
/**
 * Judge output the eval echoes. `JUDGE[: ]` and not `JUDGE (DROPPED|...)`,
 * because a judge that ran and removed nothing prints only `JUDGE: n in, n out`
 * -- under the narrower pattern a clean judging produced no output at all and the
 * log could not answer whether judging happened. Exported so its test cannot
 * quietly hold a second copy: the first version of that test inlined the regex,
 * so reverting this line failed nothing.
 */
export const JUDGE_LOG_RE = /JUDGE[: ]|CAPPED/;

export function matches(expected, findings, body = null) {
  const sameFile = findings.filter((f) => f.path === expected.path);
  if (sameFile.length === 0) return { hit: false, by: null };

  // MATCHED ON `body` AND `class`, NEVER ON `quote`. `quote` is verbatim source
  // from the diff under review, so folding it in made the finding's own evidence
  // count as agreement: PR #3598's hunks literally contain `REMEDY: re-run the
  // review job` and `exemption`, so ANY finding anchored near those lines scored
  // as recall of the contradictory-remedy defect. A harness that credits a
  // reviewer for quoting the diff is measuring nothing.
  const blobOf = (f) => `${f.body ?? ''} ${f.class ?? ''}`.toLowerCase();

  // STEMS BOTH WAYS. A 7-character prefix of the EXPECTED word, matched as a
  // substring of the finding, fails on inflection in the direction that hurts
  // most: "throws" does not appear in "Throwing", "reddeni" does not appear in
  // "reddens", so a finding naming the defect exactly scored as a MISS -- and a
  // miss is what gets a good rubric reverted. Stemming both sides to 5 and
  // comparing prefixes matches word FORMS without matching different words.
  const stem = (w) => w.toLowerCase().slice(0, 5);

  // GENERIC REVIEW VOCABULARY IS NOT EVIDENCE. `output`, `prints`, `remedy`,
  // `should` and friends appear in half this repository's prose, and two of them
  // co-occurring in an unrelated finding scored as a hit on a shipped case.
  const GENERIC = new Set(
    ['output', 'print', 'remed', 'shoul', 'becau', 'witho', 'nothi', 'canno', 'sayin', 'along',
     'happe', 'somet', 'chang', 'retur', 'value', 'metho', 'funct', 'callи'].map(stem),
  );
  // WORDS THE PR BODY ALREADY SUPPLIES ARE NOT EVIDENCE EITHER, for exactly the
  // reason `quote` is excluded above: the body is handed to the reviewer, so
  // crediting it for repeating the body measures copying, not review. It matters
  // on the one case whose defect IS a body/diff contradiction -- there the body
  // supplied 6 of 13 expected terms, and two are enough to score, so a reviewer
  // that paraphrased the description and never opened the file scored a hit.
  // What survives is the vocabulary only the CODE can supply.
  // ONE TOKENIZER. This expression appeared three times, differing only in the
  // minimum length, and the relationship that makes the body exclusion sound --
  // the body must be tokenized at least as permissively as the expected terms --
  // was held by nothing but the lines being adjacent. Raising the body's minimum
  // to 5 would have silently stopped the exclusion catching anything, with every
  // test still green.
  const tokens = (text, min) =>
    new Set((String(text ?? '').match(new RegExp(`[A-Za-z_][A-Za-z0-9_]{${min - 1},}`, 'g')) || []).map(stem));

  const fromBody = tokens(body, 5);
  const terms = [...tokens(expected.what, 6)].filter((t) => !GENERIC.has(t) && !fromBody.has(t));

  for (const f of sameFile) {
    const words = tokens(blobOf(f), 5);
    const hits = terms.filter((t) => words.has(t));
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
    // MATCHED ONCE. It used to be called here and again below with identical
    // arguments, so threading the PR body through required editing both sites --
    // and missing one would have been silent: `claimed` would have been built
    // without the body exclusion, the EXTRA list would have quietly shrunk, and
    // recall would have printed the same number either way.
    const ms = c.expected.map((e) => matches(e, c.findings, c.body));
    for (const [i, e] of c.expected.entries()) {
      total += 1;
      const m = ms[i];
      if (m.hit) hits += 1;
      lines.push(`    ${m.hit ? '✅ FOUND   ' : '❌ MISSED  '} ${e.path}: ${e.what.slice(0, 88)}`);
      if (m.hit) lines.push(`               via ${m.by}`);
    }
    // BUILT FROM WHAT ACTUALLY MATCHED, not from the expected paths. The first
    // version excluded every finding in a file that HELD an expected finding, so
    // a second, genuinely different defect in that same file was neither a hit,
    // nor an extra, nor printed -- silently dropped, in exactly the files a rubric
    // change is most likely to produce new findings in. The docblock's promise
    // that "the harness prints each one so a human decides" failed precisely
    // where it mattered.
    const claimed = new Set(
      ms.map((m) => m.by).filter(Boolean).map((by) => by.split(' ')[0]),
    );
    const others = c.findings.filter((f) => !claimed.has(`${f.path}:${f.line}`));
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
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const rubric = arg('--rubric', join(HERE, 'rubric.md'));
  const model = process.env.EVAL_MODEL || 'sonnet';
  const noJudge = process.argv.includes('--no-judge');
  const tmp = mkdtempSync(join(tmpdir(), 'rubric-eval-'));
  // Removed on SUCCESS only. It holds each case's raw reviewer output and
  // validated findings, which is exactly what you need when a case fails --
  // deleting it on the failure path would throw away the evidence the harness
  // exists to produce. On success it is megabytes of noise per run.
  let ok = false;
  try {

    // `--cases` and `--reviewer` exist so the ORCHESTRATION can be exercised for
    // real: point the harness at a fixture case and at a deterministic stub in
    // place of the model, and every other stage -- validate-findings included --
    // still runs as a genuine child process. Nothing is mocked, so a test can ask
    // what the harness DOES rather than what its source says.
    const caseDir = arg('--cases', CASE_DIR);
  // EXPLICIT ONLY. This defaulted to HEAD, which silently turned the documented
  // diff-only baseline into a context-enabled run -- the comment below said
  // "without it the eval measures the old behaviour" while the code three lines
  // up guaranteed it never could. A baseline you cannot reproduce is not a
  // baseline. Pass `--base HEAD` to retrieve siblings from the current checkout.
  const baseRef = arg('--base', null);
    const reviewer = arg('--reviewer', join(HERE, 'run-reviewer.mjs'));

    const files = readdirSync(caseDir).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0) throw new Error('No eval cases found; the harness would report a vacuous 0/0.');

    const results = [];
    for (const f of files) {
      const c = JSON.parse(readFileSync(join(caseDir, f), 'utf8'));
      // THE CONTEXT PACK, built per case so the eval measures the pipeline the
    // lane actually runs rather than a diff-only ghost of it. `--base` names
    // the tree siblings are retrieved from; without it the eval measures the
    // old behaviour, which is exactly what the baseline run did.
    if (baseRef) {
      try {
        // `body` MATTERS, and its absence was not merely an untested prompt
        // section. pr-3389's expected defect IS "the PR body describes a null
        // sentinel meaning cannot answer yet, but the helper treats null and
        // empty array identically" -- detectable only by comparing the
        // description against the diff. With no body that case was unscoreable:
        // a permanent miss no rubric change could ever convert, quietly
        // depressing recall and inviting a rubric "fix" for a harness defect.
        const patchBytes = c.input.files.reduce((n, ff) => n + Buffer.byteLength(ff.patch, 'utf8'), 0);
        c.input.contextPack = buildPack(c.input, { baseRef, body: c.body ?? null, patchBytes });
        // The eval scores a pack the same way the lane builds one, so it has to be
        // able to say when no pack was built. Its own workflow comment describes this
        // exact symptom -- a shallow checkout leaves every case's file evidence empty
        // -- and without this the harness prints a recall number for a pack that was
        // never assembled, which is how the 7% -> 20% figure came to be wrong twice.
        if (retrievalFailed(c.input.contextPack, c.input.files.length)) {
          console.log(
            `  ${f}: ${retrievalFailedMessage(c.input.headSha, c.input.files.length)} Expected here: ` +
              'every eval case names a squash-merged PR head, which no clone depth reaches. Siblings ' +
              'and the description are still scored; whole-file evidence is not.',
          );
        }
      } catch (err) {
        console.log(`  ${f}: context pack unavailable (${err?.message ?? 'unknown'})`);
      }
    }
    const inputPath = join(tmp, `${f}.input.json`);
      const outPath = join(tmp, `${f}.out.txt`);
      writeFileSync(inputPath, JSON.stringify(c.input));
      const r = spawnSync(
        process.execPath,
        [reviewer, '--rubric', rubric, '--input', inputPath, '--out', outPath, '--model', model],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) {
        // A case that could not run is NOT a case that found nothing. Scoring it as
        // a miss would blame the rubric for a drained pool.
        console.error(`${r.stdout || ''}${r.stderr || ''}`.trim());
        throw new Error(`Case ${f} did not run. The reviewer's own verdict is above; the score is not computable.`);
      }
      // THROUGH `validate-findings`, EXACTLY AS THE LANE DOES -- and the canary
      // had to learn this the same way an hour earlier. `run-reviewer.mjs --out`
      // writes RAW model text, and the model FENCES it: this step failed on its
      // first live run with
      //
      //   SyntaxError: Unexpected token '`', "```json ...
      //
      // even though rubric.md says "no prose, no markdown fence". That is worth
      // knowing on its own -- the fence-stripping in `validate-findings` is
      // load-bearing rather than defensive -- and it means any harness that parses
      // the raw output is measuring a pipeline the lane does not have.
      //
      // Running the real chain also makes the score honest in a second way: the
      // lane POSTS validated findings, so recall over unvalidated ones would credit
      // the reviewer for findings that would have been dropped for quoting a line
      // that is not in the diff.
      const findingsPath = join(tmp, `${f}.findings.json`);
      const v = spawnSync(
        process.execPath,
        [join(HERE, 'validate-findings.mjs'), '--raw', outPath, '--input', inputPath, '--out', findingsPath],
        { encoding: 'utf8' },
      );
      // A non-zero exit is not one thing: see REVIEWER_FAULT above for which
      // refusals are the model answering badly (scored zero, the eval carries on)
      // and which mean the harness broke (stop).
      const said = `${v.stdout || ''}${v.stderr || ''}`.trim();
      if (v.status !== 0) {
        // FROM STDERR ONLY. `said` concatenates stdout, and stdout carries the
        // per-finding DROPPED warnings, which interpolate the model's own `path`
        // unescaped. A path of "x.ts\n\u274c NO_RAW: injected" puts a forged reason
        // line ahead of the real one, and `.exec` takes the first match -- turning
        // a reviewer fault into a fabricated instrument fault that aborts the run.
        // validate-findings prints exactly one reason line, always on stderr.
        const reason = validatorReason(v.stderr || '');
        if (!REVIEWER_FAULT.has(reason)) {
          console.error(said);
          throw new Error(
            `Case ${f}: the validator refused the harness's own input (${reason ?? 'unknown'}). ` +
              'That is a lane regression, not a rubric score; the verdict is above.',
          );
        }
        console.log(`  ${f}: scored ZERO -- the reviewer's answer did not survive validation (${reason}).`);
        console.log(said.split('\n').map((l) => `    ${l}`).join('\n'));
        // NOT `verdict: 'findings'`. On RAW_EMPTY the model said nothing at all,
        // and printing a verdict it never gave is the same fabrication
        // validate-findings refuses to make. `null` is what actually happened.
        //
        // `body` IS WHAT THE REVIEWER SAW, not the fixture's. The pack truncates
        // the description, and a diff-only run carries none at all -- scoring
        // against text the reviewer never received excludes vocabulary it could
        // not have copied, and that reads as a false miss.
        results.push({ pr: c.pr, body: c.input.contextPack?.body ?? null, expected: c.expected, verdict: null, findings: [] });
        continue;
      }
      // PARTIAL losses exit 0. DROPPED is one finding refused; CAPPED is the
      // MAX_FINDINGS ceiling, and a 7-finding review silently loses 2. Either way
      // recall falls, and without this nothing on screen separates "the reviewer
      // missed it" from "the pipeline discarded it".
      const lost = said.split('\n').filter((l) => /DROPPED|CAPPED/.test(l));
      if (lost.length) console.log(lost.map((l) => `    ${f}: ${l.trim()}`).join('\n'));
      // THE JUDGE RUNS HERE FOR THE SAME REASON THE VALIDATOR DOES: the lane posts
      // judged findings, so scoring unjudged ones measures a pipeline that does not
      // exist. It matters more than the validator did, because the judge is the half
      // of the inversion that can LOWER recall -- if it is eating real findings, this
      // is the only place that shows up before a human's PR does. `--no-judge` scores
      // the generator alone, which is how you tell "the reviewer missed it" from "the
      // judge threw it away".
      let parsed = JSON.parse(readFileSync(findingsPath, 'utf8'));
      // Nothing to judge costs no process. `judge()` short-circuits on an empty
      // list anyway, so this only saves a node start -- but four of the fixtures
      // expect zero findings and more come back clean in practice.
      if (!noJudge && parsed.findings?.length > 0) {
        const judgedPath = join(tmp, `${f}.judged.json`);
        const j = spawnSync(
          process.execPath,
          [join(HERE, 'run-judge.mjs'), '--findings', findingsPath,
           '--judge-rubric', join(HERE, 'judge.md'), '--out', judgedPath, '--model', 'haiku'],
          { encoding: 'utf8' },
        );
        const jsaid = `${j.stdout || ''}${j.stderr || ''}`.trim();
        // `JUDGE:` IS IN THE FILTER, and leaving it out made the instrument
        // unreadable. A judge that ran and dropped nothing prints only
        // `JUDGE: n in, n out`, which the old pattern did not match -- so a clean
        // judging produced NO output at all, and a whole CI eval could not answer
        // "did the judge run". I read one such log as evidence the judge had eaten
        // a finding, when it had run and removed nothing. The instrument has to
        // say what it did, including when it did nothing.
        const jlost = jsaid.split('\n').filter((l) => JUDGE_LOG_RE.test(l));
        if (jlost.length) console.log(jlost.map((l) => `    ${f}: ${l.trim()}`).join('\n'));
        // READ THE RECORD, DO NOT INFER FROM THE EXIT CODE. Every likely judge
        // failure -- no credential, quota drained, CLI missing -- is caught inside
        // run-judge.mjs and exits 0, so a status check could never fire for any of
        // them: the loud warning was structurally unreachable while the quiet
        // stdout line said the opposite. `judged` is written by the thing that
        // knows.
        if (j.status === 0) parsed = JSON.parse(readFileSync(judgedPath, 'utf8'));
        if (j.status !== 0 || parsed.judged !== true) {
          console.log(`  ${f}: THE JUDGE DID NOT RUN. Scoring unjudged findings; this is not a Stage 3 number.`);
        }
      }
      // CAPPED LIKE THE POSTER, for the same reason the judge runs here at all: the
      // lane posts five, and scoring twelve credits the reviewer for findings no
      // author ever sees. `validate-findings` states outright that the order is the
      // model's, not a severity ranking, so a defect matched at position nine counts
      // as recall of something production drops.
      const all = parsed.findings ?? [];
      const posted = all.slice(0, MAX_POSTED_FINDINGS);
      if (all.length > posted.length) {
        console.log(`  ${f}: ${all.length - posted.length} finding(s) beyond the posting cap are not scored.`);
      }
      // Same rule as the failure record above: the exclusion is keyed to what
      // the reviewer RECEIVED, `c.input.contextPack?.body`, never the fixture.
      results.push({ pr: c.pr, body: c.input.contextPack?.body ?? null, expected: c.expected, verdict: parsed.verdict, findings: posted });
    }

    const s = score(results);
    console.log(`\nRubric: ${rubric}   model: ${model}`);
    for (const l of s.lines) console.log(l);
    // A case whose review never validated contributes zero to recall, and a recall
    // number is not readable without knowing how many of those there were.
    const noReview = results.filter((r) => r.verdict === null).length;
    console.log(`\n  RECALL of known findings: ${s.recall}`);
    if (noReview) {
      console.log(`  ...over ${results.length} cases, of which ${noReview} PRODUCED NO USABLE REVIEW and scored zero.`);
    }
    console.log(`  EXTRA findings (look at these, do not minimise them): ${s.extra}`);
    console.log('\n  Compare against the same command on the other rubric. A change that lowers');
    console.log('  recall is a regression whatever it does to EXTRA.\n');
    ok = true;
  } finally {
    if (ok) rmSync(tmp, { recursive: true, force: true });
    else console.error(`\n  Left the working directory in place for diagnosis: ${tmp}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('rubric-eval.mjs')) main();
