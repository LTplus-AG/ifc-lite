#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * THE LANE'S LIVENESS CANARY. Runs the real reviewer over a frozen diff whose
 * answer is known, and fails when it cannot find it.
 *
 * WHY THIS EXISTS. The lane's credential is a manually-refreshed subscription
 * token. It expired once already, and the day it did the failure was invisible:
 * `Review posted` went red on individual PRs, which is a NON-REQUIRED check that
 * looks exactly like every other transient red. Nothing aggregated it, so
 * "the reviewer has been dark for a week" and "this PR had a blip" render the
 * same. Meanwhile CodeRabbit's ceiling is roughly a third of this repo's volume,
 * so a dark lane means most PRs get no review while every check still looks
 * normal.
 *
 * WHAT IT ASSERTS, and why it is not just a token ping. A ping proves the
 * credential authenticates. It does not prove the reviewer still REVIEWS: a
 * rubric edit, a model change, a truncated prompt or a validator regression can
 * all leave a lane that authenticates fine and finds nothing. So the canary
 * demands a FINDING on an input that contains one:
 *
 *   verdict=findings, and a finding on the planted file must explain the defect.
 *
 * A `clean` verdict here is a FAILURE. That is the whole point -- it is the one
 * assertion that separates "reviewing" from "answering".
 *
 * THE INPUT IS FROZEN, DELIBERATELY. Replaying a real PR would re-measure a diff
 * whose findings shift with everything around it, so a red would be ambiguous
 * between "the reviewer broke" and "the diff changed". This fixture cannot
 * change, so a red means the reviewer changed.
 *
 * NO SUBDIRECTORY, DELIBERATELY. `test.yml`'s catch-all runs
 * `scripts/review/*.test.mjs` and is per-DIRECTORY -- its own comment says it
 * "goes blind on the next subdirectory anyone adds". A `canary/` folder was the
 * next subdirectory, and `check-test-glob-coverage` did not catch it (it audits
 * packages). So this lives flat, where the existing glob reaches it.
 *
 * STATED HOLE: one fixture measures one defect class. It answers "is the lane
 * alive and still finding things", NOT "is the lane's recall good" -- that is a
 * different instrument (an eval over many known findings) and it belongs in a
 * different file. Do not let a green canary be read as a recall measurement.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Thrown for every fail-closed condition; `reason` is the machine-readable tag. */
export class CanaryError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'CanaryError';
    this.reason = reason;
  }
}

/**
 * The planted defect: what a finding about it must be ON, and what it must
 * talk ABOUT (#5621).
 *
 * The defect: `Number(raw)` of a missing or non-numeric value is NaN, NaN
 * loses the one-ended `timeoutMs > 0` comparison, and control falls through
 * to `return 0`, which closes the session. The same guard also lets
 * `"Infinity"` through with no upper bound. EVERY added line of the fixture is
 * part of this defect: it is a six-line change with nothing else in it.
 *
 * ON: `path`. `validate-findings.mjs` has already dropped any finding whose
 * quote is not the text of an added line of the file it names, so a surviving
 * finding on this path is anchored to the defect's own code.
 *
 * ABOUT: `about`. The body has to engage with what the code DOES with a bad
 * value: the input it mishandles (NaN, non-numeric, unparsable, missing,
 * undefined, Infinity, the bound or guard) OR what that input turns into (it
 * returns 0 or falls back, the session closes or expires immediately, the
 * timeout never expires, the old DEFAULT_TIMEOUT_MS is gone). Either side is
 * enough. That refuses a style nit on the right line ("rename timeoutMs").
 *
 * WHY SO BROAD, AND NOT A STRICTER WORDING RULE. #5621 was a wording rule
 * misfiring. The first judge demanded the literal symbol `timeoutMs`, and the
 * destructive line, `return 0;`, does not contain it. The first branch run with
 * findings printed showed three of four correct findings anchored there, and it
 * went green only because the fourth happened to quote the `if` line. Every
 * narrower rule tried since then also rejected a correct finding the lane
 * really produced. One required "NaN", but a Claude CLI run described the same
 * fall-through as "any unparsable or missing raw value now silently returns 0".
 * Another required a return-0 consequence, but the Infinity end's consequence
 * is "the session timeout never expires". A false alarm on this canary means
 * "most PRs are unreviewed", which people learn to mute. So the rule asks only
 * that the finding is on the defect and about the value handling.
 *
 * STATED HOLE: this is keyword evidence, not comprehension. A body that is on
 * the defect's lines and names one of these words passes even if it is wrong
 * or negates the defect ("no NaN issue here"). The canary measures liveness,
 * as its file header says, and a reviewer that writes about the value handling
 * of this diff is reading it. Recall and precision are a different instrument.
 */
export const PLANTED_DEFECT = Object.freeze({
  path: 'src/session-timeout.ts',
  // One alternation, two halves. The input the one-ended guard mishandles:
  // NaN, non-numeric, unparsable, invalid, missing, undefined, Infinity, the
  // bound or guard itself. Then what it turns into: returns 0, falls back or
  // through, zero, 0ms, closes, expires, terminates, immediately, unbounded,
  // the lost DEFAULT_TIMEOUT_MS.
  about:
    /\bNaN\b|not[- ]a[- ]number|\bnon-?numeric\b|\bunparsa?ble\b|\binvalid\b|\bmissing\b|\bundefined\b|\bInfinity\b|\b(?:upper|lower)[- ]?bound|\bguard|one[- ](?:ended|end\b|sided)|\breturn(?:s|ing|ed)?\s+`?0|\bfall(?:s|ing)?[- ]?(?:back|through)|\bzero\b|\b0\s?ms\b|\bclos(?:e|es|ing|ed)\b|\bexpir|\bterminat|\bimmediately\b|\bunbounded\b|\bDEFAULT_TIMEOUT_MS\b/i,
});

/**
 * Does this review actually find the planted defect?
 *
 * TWO CONDITIONS, and the second is what stops a lucky pass. A model that
 * answers `findings` with a finding about something else has not found THIS
 * defect, and a canary satisfied by any non-empty list would go green on a
 * reviewer that had started hallucinating. So at least one finding must be on
 * the planted file AND its body must be about the value handling (see
 * PLANTED_DEFECT for why that bar, and its stated hole).
 *
 * @param {object} parsed - the validator's findings.json.
 * @param {{ path: string, about: RegExp }} [planted]
 * @returns {{ ok: boolean, why: string }}
 */
export function judge(parsed, planted = PLANTED_DEFECT) {
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, why: 'the reviewer returned something that is not an object' };
  }
  if (parsed.verdict !== 'findings') {
    return {
      ok: false,
      why:
        `verdict=${JSON.stringify(parsed.verdict)}, expected "findings". The canary diff contains a ` +
        'numeric bound guarded at one end -- `Number(raw)` of a non-number is NaN, NaN loses every ' +
        'comparison, so it takes the else branch and returns 0, closing the session immediately. ' +
        'A reviewer that calls this clean is answering, not reviewing.',
    };
  }
  const list = Array.isArray(parsed.findings) ? parsed.findings : [];
  if (list.length === 0) {
    return { ok: false, why: 'verdict=findings with an EMPTY findings list, which contradicts itself' };
  }
  const found = list.filter(
    (f) =>
      f &&
      f.path === planted.path &&
      typeof f.body === 'string' &&
      planted.about.test(f.body),
  );
  if (found.length === 0) {
    return {
      ok: false,
      why:
        `${list.length} finding(s), but none on \`${planted.path}\` explains the defect ` +
        '(its body must be about how a bad value is handled; see PLANTED_DEFECT). Findings about something ' +
        'else do not show this defect was found.',
    };
  }
  return { ok: true, why: `${list.length} finding(s), ${found.length} explaining the planted defect` };
}

/**
 * The surviving findings, one block each, as the canary's log shows them. The
 * judge's verdict alone cannot be diagnosed: "none names X" says a finding
 * existed and not what it said (#5621).
 *
 * @param {object} parsed - the validator's findings.json.
 * @returns {string}
 */
export function describeFindings(parsed) {
  const list = Array.isArray(parsed?.findings) ? parsed.findings : [];
  if (list.length === 0) return `canary: verdict=${JSON.stringify(parsed?.verdict)}, no surviving findings.`;
  const clip = (t) => {
    const s = String(t ?? '').replace(/\s+/g, ' ').trim();
    return s.length > 400 ? `${s.slice(0, 400)}...` : s;
  };
  const rows = list.map(
    (f, i) =>
      `  [${i}] ${f.path}:${f.line}${f.source ? ` (from ${f.source})` : ''}\n` +
      `      quote: ${clip(f.quote)}\n` +
      `      body:  ${clip(f.body)}`,
  );
  return `canary: verdict=${JSON.stringify(parsed.verdict)}, ${list.length} surviving finding(s):\n${rows.join('\n')}`;
}

function main() {
  const fixture = join(HERE, 'lane-canary-fixture.json');
  const rubric = join(HERE, 'rubric.md');
  const out = join(mkdtempSync(join(tmpdir(), 'canary-')), 'raw.txt');

  const r = spawnSync(
    process.execPath,
    [join(HERE, 'run-reviewer.mjs'),
     '--rubric', rubric, '--input', fixture, '--out', out, '--model', process.env.CANARY_MODEL || 'sonnet'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  // PRINTED ON EVERY PATH, not only on failure (#5621). The reviewer's log is
  // where the ensemble names which models answered, which were excluded from
  // the pool and why; the canary's first red with a live reviewer said only
  // "1 finding(s), but none names timeoutMs", with no way to tell a reviewer
  // that missed the defect from a validator that dropped the finding that
  // named it.
  if (r.status === 0) console.log(log.trim());
  if (r.status !== 0) {
    // The reviewer's own error classes already name the remedy; do not restate
    // them, forward them. AUTH_FAILED and QUOTA_DRAINED are the two this canary
    // exists to surface, and they are exactly the ones that go unnoticed per-PR.
    console.error(log.trim());
    throw new CanaryError('LANE_DOWN', 'The reviewer did not complete. Its own verdict is above.');
  }

  // THROUGH `validate-findings`, EXACTLY AS THE LANE DOES. The first version
  // JSON.parsed the reviewer's RAW output and failed on its first live run with
  // BAD_OUTPUT -- because `run-reviewer.mjs --out` writes raw model text, and it
  // is `validate-findings.mjs` that parses it, strips fencing, checks the quotes
  // against the diff and drops anything unanchored. So the canary was not merely
  // failing to parse: it was testing a pipeline the lane does not have, and a
  // canary that exercises a different path from the thing it watches is worth
  // less than no canary.
  //
  // Running the real chain means the canary now also covers the validator: a
  // regression that rejects every finding shows up here as "found nothing",
  // which is the same red as a dead reviewer and wants the same look.
  const findingsPath = join(dirname(out), 'findings.json');
  const v = spawnSync(
    process.execPath,
    [join(HERE, 'validate-findings.mjs'), '--raw', out, '--input', fixture, '--out', findingsPath],
    { encoding: 'utf8' },
  );
  if (v.status === 0) console.log(`${v.stdout || ''}${v.stderr || ''}`.trim());
  if (v.status !== 0) {
    console.error(`${v.stdout || ''}${v.stderr || ''}`.trim());
    throw new CanaryError(
      'VALIDATION_FAILED',
      'The reviewer answered but the validator rejected it. Its verdict is above -- that is a lane ' +
        'regression even though the reviewer itself exited 0.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(findingsPath, 'utf8'));
  } catch {
    throw new CanaryError(
      'BAD_OUTPUT',
      'The validator exited 0 but wrote findings this canary cannot read, which should be impossible ' +
        'and is a defect in the validator rather than in the review.',
    );
  }

  console.log(describeFindings(parsed));
  const verdict = judge(parsed);
  if (!verdict.ok) {
    throw new CanaryError(
      'LANE_NOT_REVIEWING',
      `The reviewer answered but did not find the planted defect: ${verdict.why}\n` +
        '   REMEDY: this is not a per-PR blip. Check, in order: the token, the subscription pool, ' +
        'and any recent change to rubric.md or run-reviewer.mjs. Until it is green, assume most ' +
        'PRs are getting no substantive review and consider `mode: advisory` on review-posted.',
    );
  }
  console.log(`Lane canary OK: ${verdict.why}.`);
}

if (process.argv[1] && process.argv[1].endsWith('lane-canary.mjs')) {
  try {
    main();
  } catch (err) {
    if (err instanceof CanaryError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
