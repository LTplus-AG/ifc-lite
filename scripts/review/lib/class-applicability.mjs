/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WHICH DEFECT CLASSES THIS DIFF CAN ACTUALLY CARRY (#3831 round 2).
 *
 * WHY THIS EXISTS. The first cut of the per-class pass checked the SHAPE of the
 * model's answer: twelve rows, each with a verdict and a reason, no two reasons
 * identical. That is a lexical bar, and a lexical bar is trivially cleared
 * without doing any work. Both of these passed it while reviewing nothing:
 *
 *     { class: "test-that-cannot-fail",   verdict: "not-applicable",
 *       why: "no such code in diff (7)" }
 *     { class: "one-ended-numeric-bound", verdict: "not-applicable",
 *       why: "one-ended-numeric-bound does not apply" }
 *
 * Twelve distinct sentences, none of them a reason. So the check is now bound to
 * the DIFF instead of to the prose: for each class, a cheap deterministic
 * predicate says whether this diff could carry it, and a class the diff CAN
 * carry may not be waved off.
 *
 * CONSERVATIVE IN ONE DIRECTION ONLY, and that direction is load-bearing.
 * `false` means "we cannot tell from the diff", never "this class is absent" --
 * so a predicate that fails to fire costs nothing but a `not-applicable` the
 * model was going to be allowed anyway, while a predicate that fires WRONGLY
 * fails a review that was correct. Every pattern below is therefore written to
 * under-fire: whole-word markers, no speculative inference across files, and no
 * attempt to be complete. Recall of the classes is `rubric-eval`'s job; this is
 * only the floor under `not-applicable`.
 *
 * THE RESIDUAL IS REPORTED, NOT HIDDEN. A class whose predicate does not fire
 * can still be waved off on a diff that really did carry the defect, and
 * `lib/eval-score.mjs` prints exactly that as CLASS SKIPPED so the gap between
 * these predicates and the real defect population stays visible in the eval
 * rather than being quietly absorbed.
 */

import { newFileLines } from '../build-review-input.mjs';

/** Every added line of a patch, with its new-file line number. */
function addedLines(patch) {
  return newFileLines(String(patch ?? '')).filter((r) => r.kind === 'added');
}

/**
 * The first added line in the diff matching `re`, as `{ path, line, text }`.
 * `null` when nothing matches, which is how a predicate declines to fire.
 *
 * `read` decides what the line IS before `re` sees it: `codeOf` for a class that
 * is a shape in code, identity for one that is a shape in text.
 */
function firstAddedMatch(input, re, read = codeOf) {
  for (const [path, file] of input.files) {
    for (const row of addedLines(file.patch)) {
      if (re.test(read(row.text))) return { path, line: row.line, text: row.text.trim() };
    }
  }
  return null;
}

/**
 * A line with its COMMENT text removed, so a predicate matches the code a line
 * IS rather than the English a comment SAYS.
 *
 * MEASURED, on #3848 itself. `merged-distinct-entries` fired on line 18 of this
 * very file -- "Twelve distinct sentences, none of them a reason" -- and the
 * wave-off branch refused an otherwise correct clean review, reddening the lane
 * on a docblock. That is the failure this file's header says it is written to
 * avoid: a predicate that fails to fire costs a `not-applicable` the model was
 * going to be allowed anyway, and one that fires wrongly fails a review that was
 * correct. Stripping is therefore in the SAFE direction by construction, and the
 * same reasoning `unpartneredComparison` already applies to string contents.
 *
 * Line comments, block comments, a leading JSDoc continuation `*`, and a
 * WHOLE-LINE `#` comment.
 * The `#` case is anchored at the start deliberately: Rust's `#[test]` and a
 * trailing `#fff` or `#field` are not comments, and truncating a line at the
 * first `#` anywhere would blind `test-that-cannot-fail` to the attribute it
 * looks for. STATED RESIDUAL: a trailing `#` comment in Python or YAML is not
 * stripped, so a class can still fire on one. That is an under-strip, which
 * costs a wave-off, not a red lane.
 */
function codeOf(text) {
  return String(text)
    .replace(/^\s*\*.*$/, ' ')           // a JSDoc continuation line is all comment
    .replace(/^\s*#(?![[!]).*$/, ' ')     // a whole-line `#` comment, but not `#[attr]`
    .replace(/\/\*.*?\*\//g, ' ')
    .replace(/\/\*.*$|\/\/.*$/, ' ');
}

/** The first changed path matching `re`, anchored at that file's first added line. */
function firstPathMatch(input, re) {
  for (const [path, file] of input.files) {
    if (!re.test(path)) continue;
    const first = addedLines(file.patch)[0];
    return { path, line: first?.line ?? null, text: first?.text?.trim() ?? '' };
  }
  return null;
}

/**
 * A comparison operator with no partner in the same added line. `a > b` fires;
 * `a > b && a < c` does not, because the author already bounded both ends.
 *
 * STRING AND TEMPLATE CONTENTS ARE REMOVED FIRST, and that is not tidiness: the
 * measured false fire was a line building SVG markup in a template literal,
 * where `<path ... />` read as an unpartnered `<`. A predicate that fires
 * wrongly fails a review that was correct, so the markup a line PRINTS must not
 * be mistaken for the comparisons it MAKES. Arrow functions, Rust arrows, JSX
 * closers, shift operators and generic parameters go the same way, or every
 * TypeScript diff in the repository would fire on `=>` alone.
 */
function unpartneredComparison(text) {
  const stripped = String(text)
    .replace(/\\./g, ' ')                          // escapes, before any quote matching
    .replace(/`[^`]*`|'[^']*'|"[^"]*"/g, ' ')      // string and template CONTENTS
    .replace(/\/\/.*$|\/\*.*?\*\//g, ' ')            // comments
    .replace(/=>|->|<<|>>|<\/|\/>/g, ' ')
    .replace(/<[A-Za-z_$][^<>]*>/g, ' ');          // generic parameters, not comparisons
  const lower = (stripped.match(/(?:^|[^<>=!])(<=?)(?![=<])/g) || []).length;
  const upper = (stripped.match(/(?:^|[^<>=!])(>=?)(?![=>])/g) || []).length;
  return (lower > 0) !== (upper > 0);
}

/**
 * The predicates, keyed by the class ids in ./defect-classes.mjs. Each returns
 * the diff site that makes the class applicable, or `null`.
 *
 * `defect-classes.mjs` holds every id to exactly one entry here, so a class
 * added there without a predicate fails loudly instead of silently becoming
 * un-waveable-off or always-waveable-off.
 */
export const APPLIES = {
  // A second site is applicable exactly when the harness FOUND one and put it in
  // the pack. Inferring it from the diff alone would be guessing at files we
  // were not shown, which is the one thing the rubric forbids outright.
  'duplicate-site': (input) => {
    const sib = (input.contextPack?.siblings ?? [])[0];
    return sib ? { path: sib.path, line: sib.line, text: 'a sibling excerpt was retrieved for this diff' } : null;
  },

  'version-bump-shape': (input) =>
    firstPathMatch(input, /(^|\/)\.changeset\/[^/]+\.md$|(^|\/)package\.json$|(^|\/)Cargo\.toml$/),

  // Only when a description was actually supplied: with no body there is nothing
  // for the diff to contradict.
  'description-mismatch': (input) => {
    const body = input.contextPack?.body;
    return typeof body === 'string' && body.trim() !== ''
      ? { path: null, line: null, text: 'a PR description was supplied with this diff' }
      : null;
  },

  'merged-distinct-entries': (input) =>
    firstAddedMatch(input, /new Set\(|\.filter\(|\bdedup|\buniq|\bdistinct\b|\bunion\b|\bgroupBy\b/i),

  'behaviour-break-on-surviving-export': (input) =>
    firstAddedMatch(input, /^\s*(export\s|pub\s+fn\b|pub\s+struct\b|pub\s+enum\b)/),

  'absence-reads-as-success': (input) =>
    firstAddedMatch(input, /\breturn\s+(null|undefined|\[\]|\{\}|false|0)\s*[;,)]|\bcatch\s*[({]|\bNone\b/),

  'falsy-boundary-value': (input) =>
    firstAddedMatch(input, /if\s*\(\s*!|\|\||\?\?|\.length\s*\?|\bBoolean\(/),

  'one-ended-numeric-bound': (input) => {
    for (const [path, file] of input.files) {
      for (const row of addedLines(file.patch)) {
        if (unpartneredComparison(row.text)) return { path, line: row.line, text: row.text.trim() };
      }
    }
    return null;
  },

  'partial-state-clear': (input) =>
    firstAddedMatch(input, /\bclear\(\)|\breset\(|\.delete\(|localStorage|sessionStorage|\bsplice\(/),

  // A unit that is right in one language and read wrongly in another needs BOTH
  // languages present. One file cannot disagree with itself across the boundary.
  'unit-correct-caller-wrong': (input) => {
    const rust = firstPathMatch(input, /\.rs$/);
    const ts = firstPathMatch(input, /\.(ts|tsx|mts|cts|js|mjs|cjs)$/);
    return rust && ts ? rust : null;
  },

  'test-that-cannot-fail': (input) =>
    firstPathMatch(input, /\.(test|spec)\.[^/]+$|(^|\/)tests?\/|_test\.rs$/) ??
    firstAddedMatch(input, /#\[test\]|\bassert[._(]|\bexpect\(/),

  // Fires only on text that is addressing a reader, not on every fenced diff:
  // "check the fence" is not a defect class, and asking for a cited line on
  // every review would charge a citation for a question with no site.
  //
  // THE ONE PREDICATE THAT READS THE RAW LINE, comments and all. Every class
  // above is a shape in CODE, so a comment naming one is a false fire (#3848).
  // This one is a shape in TEXT -- an instruction addressed at the reviewer --
  // and a comment is precisely where such an instruction gets written. Handing
  // it `codeOf` would blind it at the only site the class has ever appeared.
  'injection-attempt': (input) =>
    firstAddedMatch(input, /ignore (all |the )?(previous|prior|above)|system prompt|you are (an? )?(ai|assistant|reviewer)|as the maintainer|do not report/i, (t) => t),
};

/**
 * Which classes this diff can carry, as `Map<class, site>`.
 * @param {{ files: Map<string, {patch: string}>, contextPack?: object|null }} input
 */
export function applicableClasses(input) {
  const out = new Map();
  for (const [cls, predicate] of Object.entries(APPLIES)) {
    let site = null;
    try {
      site = predicate(input);
    } catch {
      // FAILS SOFT TO "cannot tell". A predicate that throws on an odd patch
      // must not fail a review that was correct -- the whole design of this file
      // is that a wrong fire costs more than a missed one.
      site = null;
    }
    if (site) out.set(cls, site);
  }
  return out;
}
