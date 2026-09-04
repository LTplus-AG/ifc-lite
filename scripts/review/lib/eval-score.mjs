/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE EVAL SCORER (module-size budget, #3831 split out of rubric-eval.mjs).
 * `matches` decides whether one review surfaced one known defect, `score` turns
 * a run's per-case results into the recall/EXTRA/skipped-class numbers the
 * harness prints. Pure over already-collected results, so every branch --
 * including the class-skip attribution -- is drivable without a model call.
 */

import { DEFECT_CLASSES } from './defect-classes.mjs';

/**
 * Did the review surface this known finding?
 *
 * Matched on PATH plus any distinctive term from the description, not on exact
 * wording: two reviewers describing the same defect will not phrase it alike,
 * and demanding they do would score paraphrase rather than recall.
 *
 * @returns {{ hit: boolean, by: string|null }}
 */
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

/**
 * A CASE WHOSE DEFECT CLASS THE REVIEWER DECLARED INAPPLICABLE IS STILL A MISS,
 * AND SAYS SO (#3831).
 *
 * The recall number alone cannot separate the two ways a known defect goes
 * unreported: the reviewer walked its class and did not see it, or the reviewer
 * wrote `not-applicable` against that class and never looked. Those need
 * opposite fixes -- the first is a rubric or model problem, the second is the
 * pass being waved through -- and before this they printed the same `MISSED`
 * line. Three live evaluations were read as the former when 13-14 of 18 cases
 * had produced no per-class pass at all.
 *
 * It is reported, never scored against separately: a skip is a miss, counted
 * once as a miss, and the count below exists so a human can see WHICH kind of
 * miss the recall number is made of. Nothing here can turn a miss into a hit.
 *
 * @returns {{ recall: string, hits: number, total: number, extra: number, skippedClass: number, lines: string[] }}
 */
export function score(cases) {
  const lines = [];
  let hits = 0;
  let total = 0;
  let extra = 0;
  let skippedClass = 0;
  for (const c of cases) {
    // A `class` this harness does not recognise would attribute NOTHING and
    // print a normal miss, so a typo in a case file would quietly disable the
    // attribution for that case with every test still green. Refuse it instead.
    for (const e of c.expected) {
      if (e.class !== undefined && !DEFECT_CLASSES.includes(e.class)) {
        throw new Error(
          `PR #${c.pr}: expected defect class \`${e.class}\` is not one of the rubric's classes. ` +
            'A class the reviewer is never asked about cannot be skipped, so this would score as an ' +
            'ordinary miss forever.',
        );
      }
    }
    const declaredNa = new Set(c.notApplicable ?? []);
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
      const skipped = !m.hit && e.class !== undefined && declaredNa.has(e.class);
      if (skipped) skippedClass += 1;
      lines.push(`    ${m.hit ? '✅ FOUND   ' : '❌ MISSED  '} ${e.path}: ${e.what.slice(0, 88)}`);
      if (m.hit) lines.push(`               via ${m.by}`);
      if (skipped) {
        lines.push(`               ⏭  CLASS SKIPPED: the review declared \`${e.class}\` not-applicable to this diff.`);
      }
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
    skippedClass,
    lines,
  };
}

