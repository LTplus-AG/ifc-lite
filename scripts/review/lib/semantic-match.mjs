/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE SEMANTIC EVAL MATCHER: "does this finding describe the expected defect?"
 * answered as a calibrated probability, one question per same-file finding,
 * one request per expected defect.
 *
 * WHY THE STEM MATCHER WAS NOT ENOUGH. `matches` in ./eval-score.mjs credits a
 * finding on the right path that shares two word stems with the description.
 * Replayed over the 18 eval cases and 78 candidate pairs (bench, 2026-09-21):
 * the stem rule credited 29 pairs of which 6 described the defect; this
 * matcher at 0.5 credited 7 of which 6 did, and missed none of the 6. The 23
 * false credits were "might break existing behavior", "the check is correct",
 * and wrong-sibling second-site guesses -- exactly the hits that made a
 * rubric look better than it was. The two functions coexist: the stem matcher
 * is the offline fallback and is still what the unit tests exercise without a
 * network; this one is authoritative whenever the key is present.
 *
 * WHAT IS NOT SENT. Nothing but the expected description and the findings'
 * own text: no diff, no PR body. The body exclusion that eval-score.mjs
 * argues for at length is moot here because the question is "same defect",
 * not "shares vocabulary" -- the failure mode it guards against (crediting a
 * reviewer for paraphrasing the body) is a false credit this matcher
 * measured 0 of.
 */

import { available, noul, systemOne } from './jev-client.mjs';

/** Above this, a finding counts as having surfaced the defect. Chosen on the bench, not a universal constant. */
export const MATCH_THRESHOLD = 0.5;

/** Pure: the request for one expected defect against the same-file findings. Exported so a test can pin its shape. */
export function buildMatchRequest(expected, sameFile) {
  const state = {
    expected_defect: { file: expected.path, description: expected.what, defect_class: expected.class ?? null },
    candidate_findings: sameFile.map((f, i) => ({ index: i, file: f.path, line: f.line ?? null, defect_class: f.class ?? null, text: f.body ?? '', quoted_code: f.quote ?? null })),
  };
  const questions = {};
  sameFile.forEach((_, i) => {
    questions[`same_${i}`] = noul(
      {
        question: `Does \`candidate_findings[${i}]\` describe the same underlying defect as \`expected_defect\`?`,
        note: 'Same defect means the same wrong behaviour at the same site or the same missing change; a finding that only touches the same lines, restates what the code does, or raises a different concern about the same function is not the same defect.',
      },
      {
        true: 'A maintainer reading the candidate would recognise it as reporting the expected defect, even if worded differently or less precisely.',
        false: 'The candidate reports something else, is a generic concern, or describes correct behaviour as a problem.',
      },
    );
  });
  return { state, questions };
}

/**
 * Same contract as `matches` in eval-score.mjs, resolved asynchronously.
 * @returns {Promise<{ hit: boolean, by: string|null, score: number|null }>}
 */
export async function semanticMatches(expected, findings, { env, fetchImpl, threshold = MATCH_THRESHOLD } = {}) {
  const sameFile = findings.filter((f) => f.path === expected.path);
  if (sameFile.length === 0) return { hit: false, by: null, score: null };
  const { answers } = await systemOne({ ...buildMatchRequest(expected, sameFile), env, fetchImpl });
  let best = { score: -1, f: null };
  sameFile.forEach((f, i) => {
    const p = Number(answers[`same_${i}`]?.noul);
    if (Number.isFinite(p) && p > best.score) best = { score: p, f };
  });
  if (best.f && best.score >= threshold) {
    return { hit: true, by: `${best.f.path}:${best.f.line} (P ${best.score.toFixed(2)})`, score: best.score };
  }
  return { hit: false, by: null, score: best.score < 0 ? null : best.score };
}

/**
 * Resolve every (case, expected) pair up front so `score` can stay synchronous
 * and pure: it receives a matcher that looks the answers up by position.
 * A request that fails marks its pair as unresolved, and the matcher for that
 * pair falls back to `fallback` (the stem rule) rather than to "miss".
 */
export async function semanticMatcher(cases, { env, fetchImpl, fallback, log = () => {} } = {}) {
  const resolved = new Map();
  let calls = 0;
  let failures = 0;
  for (const [ci, c] of cases.entries()) {
    for (const [ei, e] of c.expected.entries()) {
      try {
        resolved.set(`${ci}:${ei}`, await semanticMatches(e, c.findings, { env, fetchImpl }));
        calls += 1;
      } catch (err) {
        failures += 1;
        log(`semantic match unavailable for PR #${c.pr} expected[${ei}]: ${err?.message ?? err}; using the stem matcher for it`);
      }
    }
  }
  const matcher = (expected, findings, body, ctx) => {
    const r = ctx && resolved.get(`${ctx.caseIndex}:${ctx.expectedIndex}`);
    if (r) return r;
    return fallback ? fallback(expected, findings, body) : { hit: false, by: null };
  };
  return { matcher, calls, failures };
}

/**
 * What rubric-eval.mjs needs, in one call: a matcher for the validated results
 * and one for the posted results (the resolver sees both arrays concatenated,
 * validated first, so the posted case index is offset), plus a note for the
 * log. With no key both matchers are the stem rule and the note says so.
 */
export async function resolveMatchers(validatedResults, results, { env = process.env, fetchImpl, fallback, log = () => {} } = {}) {
  if (!available(env)) {
    return { forValidated: fallback, forPosted: fallback, semantic: false, note: 'stem matcher (set TYPESAFE_API_KEY for the semantic matcher)' };
  }
  const sem = await semanticMatcher([...validatedResults, ...results], { env, fetchImpl, fallback, log });
  const offset = validatedResults.length;
  return {
    forValidated: sem.matcher,
    forPosted: (e, f, b, ctx) => sem.matcher(e, f, b, { ...ctx, caseIndex: ctx.caseIndex + offset }),
    semantic: true,
    note: `semantic matcher, ${sem.calls} TypeSafe call(s)${sem.failures ? `, ${sem.failures} fell back to stems` : ''}`,
  };
}
