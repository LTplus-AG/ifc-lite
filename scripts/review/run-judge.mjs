/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The second half of the inversion.
 *
 * The lane bought precision at GENERATION time -- "when you are not sure, say
 * nothing" -- and returned clean on 45 of 46 real PRs. Precision enforced when
 * the finding is written costs recall one for one, because the only lever the
 * writer has is silence.
 *
 * CodeRabbit, the best-scoring reviewer on a 300k-PR benchmark, runs the other
 * way round: generate broadly, then suppress with verification and a judge. It
 * lands at roughly 49% precision -- half its comments are not acted on -- and
 * that is the shape of a system that finds things. Precision enforced at
 * FILTER time costs compute instead of recall.
 *
 * So this exists to let the generator be less careful. It is a pure function
 * over text like the reviewer: no tools, one turn, empty MCP, empty cwd. It
 * sees only what the harness assembled -- the finding, its verified anchor, its
 * verified sibling -- never the raw diff and never anything a PR author wrote
 * that has not already survived mechanical validation.
 *
 * IT CAN ONLY REMOVE. A judge that could edit or add findings would be a second
 * unvalidated writer; everything it keeps has already passed the validator, so
 * nothing it says can put unverified text on a PR.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fenceUntrusted, resolveTokens, runReviewerWithFailover } from './run-reviewer.mjs';
import { stripFence } from './validate-findings.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

export class JudgeError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

export function buildJudgePrompt(judgeRubric, findings) {
  const items = findings
    .map((f, i) =>
      [
        `--- FINDING ${i}`,
        `file: ${JSON.stringify(String(f.path))}  line: ${f.line}`,
        `quoted from the diff: ${JSON.stringify(String(f.quote ?? ''))}`,
        f.sibling
          ? `verified sibling: ${JSON.stringify(String(f.sibling.path))}:${f.sibling.line} ${JSON.stringify(String(f.sibling.quote ?? ''))}`
          : 'verified sibling: none',
        `class: ${JSON.stringify(String(f.class ?? 'unknown'))}`,
        // JSON.stringify'd like every other field. It was the ONE raw
        // interpolation, and the record delimiter above is a fixed, guessable
        // constant -- so a body containing a newline and `--- FINDING 0` wrote a
        // second, plausible-looking record for index 0 into the prompt, and the
        // judge answering {index:0, keep:false} deleted the real finding 0.
        // sanitizeBody strips markers and mentions but preserves newlines, and the
        // fenceUntrusted nonce wraps only the whole block, not the records in it.
        `says: ${JSON.stringify(String(f.body ?? ''))}`,
      ].join('\n'),
    )
    .join('\n\n');
  return [judgeRubric, '', '## The findings', '', fenceUntrusted(items), '', 'Emit the JSON described above and nothing else.'].join('\n');
}

/**
 * Parse the judge's answer. A malformed verdict KEEPS the finding.
 *
 * Deliberate: the judge exists to remove noise, and a parse failure is not
 * evidence that a mechanically-validated finding is wrong. Failing closed here
 * would let a truncated response silently delete real findings, which is the
 * absence-reads-as-success shape this repository keeps paying for.
 */
export function applyVerdicts(findings, raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripFence(String(raw)).trim());
  } catch {
    return { kept: findings, dropped: [],
      ran: false, note: 'judge response was not JSON; keeping all findings' };
  }
  if (parsed?.end !== 'ifc-lite-judge-v1' || !Array.isArray(parsed.verdicts)) {
    return { kept: findings, dropped: [],
      ran: false, note: 'judge response was truncated or malformed; keeping all findings' };
  }
  // EVERY VERDICT MUST ECHO ITS FINDING'S FILE, and the echo is checked.
  //
  // An index range check alone cannot see the failure that matters. A judge
  // answering 1-based AND listing only its drops -- the most natural shape a model
  // falls into -- emits no index at the top of the range, so every index lands
  // inside [0, len) and the shift is invisible. Reproduced against the previous
  // version: 5 findings, verdicts [{index:1,keep:false},{index:3,keep:false}]
  // dropped findings 1 and 3 where the judge meant 0 and 2, recorded judged:true,
  // and printed one finding's reason beside another finding's location. That is a
  // silent deletion of real findings, which is the one thing this lane exists to
  // prevent.
  //
  // So alignment is VERIFIED, not assumed. A mismatch, or a verdict carrying no
  // echo, keeps everything and says so: an inert judge is loud -- `judged: false`
  // on every run -- where a misaligned one is silent.
  // A VERDICT WITH NO INDEX IS MALFORMED, not merely inapplicable. Returning
  // false here meant such a verdict was not misaligned, not a duplicate, and
  // never entered byIndex -- so a judge answering entirely without `index` fields
  // dropped nothing and was recorded as `judged: true`. A judging that applied
  // none of its own verdicts is not a judging, and saying it succeeded is the
  // absence-reads-as-success shape this module is built to refuse.
  const misaligned = parsed.verdicts.filter((v) => {
    if (!Number.isInteger(v?.index)) return true;
    const target = findings[v.index];
    // PATH AND LINE. Path alone left one shifted case alive: a 1-based,
  // drops-only reply whose misaligned pair happens to share a file still deleted the
  // wrong finding, because the echo matched. Two findings in x.js at 10 and 20,
  // verdict {index:1, file:"x.js"}, and x.js:20 died for x.js:10's sins.
  return (
    !target ||
    typeof v.file !== 'string' ||
    v.file !== target.path ||
    !Number.isInteger(v.line) ||
    v.line !== target.line
  );
  });
  if (misaligned.length > 0) {
    const first = misaligned[0];
    return {
      kept: findings,
      dropped: [],
      ran: false,
      note:
        `${misaligned.length} verdict(s) do not match the finding they index (first: index ` +
        `${first?.index}, file ${JSON.stringify(String(first?.file ?? ''))}, expected ` +
        `${JSON.stringify(String(findings[first?.index]?.path ?? 'out of range'))}); keeping all ` +
        'findings. A verdict set that does not line up cannot be applied to any of them.',
    };
  }
  // ONE VERDICT PER FINDING, refused like misalignment when violated. `Map.set`
  // keeps the LAST duplicate, so an aligned pair for one index -- keep:true then
  // keep:false -- would silently delete a validated finding while the run is
  // recorded as judged. Two verdicts about one finding is a malformed answer,
  // and a malformed answer keeps everything and says so.
  const seen = new Set();
  for (const v of parsed.verdicts) {
    if (!Number.isInteger(v?.index)) continue;
    if (seen.has(v.index)) {
      return {
        kept: findings,
        dropped: [],
        ran: false,
        note:
          `the judge returned more than one verdict for index ${v.index}; keeping all findings. ` +
          'A verdict set that speaks twice about one finding cannot be applied to it.',
      };
    }
    seen.add(v.index);
  }
  const byIndex = new Map();
  for (const v of parsed.verdicts) {
    if (Number.isInteger(v?.index)) byIndex.set(v.index, v);
  }
  const kept = [];
  const dropped = [];
  findings.forEach((f, i) => {
    const v = byIndex.get(i);
    if (v && v.keep === false) dropped.push({ ...f, why: String(v.why ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200) });
    else kept.push(f);
  });
  return { kept, dropped, note: null, ran: true };
}

/**
 * `tokens` comes from `resolveTokens`, not from `process.env` directly. Reaching
 * past it lost two things the reviewer already owns: the trailing-newline trim
 * (`gh secret set` stores one, and it silently invalidates the credential) and
 * the second-account failover. With the judge failing soft, an expired primary
 * would have left the reviewer working on the fallback while the judge quietly
 * stopped judging every PR.
 */
export function judge({ judgeRubricPath, findings, tokens, model = 'haiku', spawn }) {
  if (findings.length === 0) return { kept: [], dropped: [], note: 'nothing to judge', ran: true };
  const rubric = readFileSync(judgeRubricPath, 'utf8');
  const prompt = buildJudgePrompt(rubric, findings);
  const { text } = runReviewerWithFailover({ prompt, model, tokens, spawn });
  return applyVerdicts(findings, text);
}

/* ------------------------------------------------------------------ the CLI */

/**
 * FAILING SOFT IS THE WHOLE CONTRACT HERE.
 *
 * The judge can only remove. So every way it can fail -- no token, CLI not on
 * PATH, a rate limit, a timeout, a malformed response -- must resolve to
 * "keep everything", never to "post nothing". The opposite wiring would make an
 * outage indistinguishable from a clean review, which is the exact shape this
 * repository has been bitten by often enough to have a name for it.
 *
 * It says so on stdout when it fails. A silent pass-through would leave the run
 * log claiming a judged review when nothing judged it.
 */
export function main(argv, {
  readFile = readFileSync,
  writeFile = writeFileSync,
  log = console.log,
  spawn,
  env = process.env,
} = {}) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };
  const findingsPath = arg('findings');
  const outPath = arg('out');
  const judgeRubricPath = arg('judge-rubric');
  if (!findingsPath || !outPath || !judgeRubricPath) {
    throw new JudgeError('USAGE', 'run-judge.mjs --findings <p> --judge-rubric <p> --out <p>');
  }

  const doc = JSON.parse(readFile(findingsPath, 'utf8'));
  const before = Array.isArray(doc.findings) ? doc.findings : [];

  let result;
  try {
    result = judge({
      judgeRubricPath,
      findings: before,
      tokens: resolveTokens(env),
      model: arg('model') ?? 'haiku',
      spawn,
    });
  } catch (err) {
    // The soft failure. Not a warning to be skimmed past: it names what did not
    // run, so nobody reads the resulting verdict as having been judged.
    log(`JUDGE UNAVAILABLE: ${err?.message ?? err}`);
    log(`Keeping all ${before.length} validated findings unjudged. The judge can only`);
    log('remove findings, so its absence costs precision, never recall.');
    result = { kept: before, dropped: [], note: 'judge did not run', ran: false };
  }

  if (result.note) log(`JUDGE NOTE: ${result.note}`);
  for (const d of result.dropped) {
    log(`JUDGE DROPPED ${d.path}:${d.line} -- ${d.why || 'no reason given'}`);
  }

  // THE POSTING CAP IS NOT HERE, and that is the point. It used to be, and the
  // workflow's crash backstop routes around this module entirely -- `cp
  // findings.json judged.json` -- so the "at most five comments reach a human"
  // invariant held only when the optional filter succeeded, and the fallback path
  // posted up to twelve. It lives in post-review.mjs now, which is the module that
  // decides what a human sees and the only one on the posting path that always
  // runs. There is also no verdict rewrite: post-review.mjs computes the marker's
  // verdict from what it reads back off the PR (`summaryBody`/`main` in
  // post-review.mjs, not a line number -- those go stale on the next commit) and never
  // looks at this field, so rewriting it here changed nothing at all.

  // `judged` is a RECORD, not an inference. The eval used to conclude the judge
  // had run from an exit code, but every likely failure -- no token, quota, no
  // CLI -- is caught here and exits 0, so the loud "THE JUDGE DID NOT RUN" warning
  // could never fire for any of them while the quiet stdout line said otherwise.
  // A consumer should read a field, not reconstruct events from a process status.
  const out = {
    ...doc,
    findings: result.kept,
    // STATED WHERE IT IS KNOWN, not reconstructed downstream. This compared
    // `result.note` against the literal 'nothing to judge' produced 77 lines
    // earlier, so rewording that sentence would have flipped `judged` to false on
    // every clean PR and made the eval print "THE JUDGE DID NOT RUN" on runs where
    // it did. A field means what it says; prose does not.
    judged: result.ran === true,
    // `kept` is RESTATED, not inherited. The validator's `kept` describes what
    // survived validation; leaving it beside a post-judge `findings` array made
    // `counts.kept !== findings.length` on any run that dropped something, and a
    // later precision tally reading these fields would have been quietly wrong.
    // `judgeInput` rather than `judged`, because the top-level `judged` is a
    // boolean about whether judging happened and two fields of one name meaning
    // different things is how this file already went wrong once.
    counts: {
      ...doc.counts,
      judgeInput: before.length,
      dropped: result.dropped.length,
      kept: result.kept.length,
    },
  };
  writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
  log(`JUDGE: ${before.length} in, ${result.kept.length} out.`);
  return out;
}

if (isMainEntry(import.meta.url)) {
  // Its two siblings both catch their error class and print a remedy
  // (run-reviewer.mjs, post-review.mjs); this printed a raw Node stack trace, so
  // `JudgeError.reason` was carried around and never read by anything.
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof JudgeError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
