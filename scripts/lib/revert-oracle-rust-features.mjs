/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rust feature-gate detection for the revert oracle (scripts/check-test-revert-oracle.mjs).
 *
 * WHY. `cargoRunner()` in revert-oracle.mjs always ran a crate's default
 * feature set. #4024's regression test
 * (rust/geometry/src/processors/boolean/chain_cycle_tests.rs) lives entirely
 * behind `#[cfg(any(feature = "csg_manifold_gate", feature =
 * "csg_topology_gate"))]`, so a default `cargo test -p ifc-lite-geometry`
 * compiles it OUT: the pre-revert and reverted runs collect the identical
 * 1273 tests and the oracle reports UNOBSERVED for a change it never even
 * compiled. This module reads the cfg-gates a changed/added test file
 * actually carries and turns them into the `--features` combination(s)
 * needed to compile it in, so `planRuns()` can spawn one cargo invocation per
 * required combination instead of a single default-only one per crate.
 *
 * ON "MUST NOT BE ENABLED TOGETHER": the scoping note that carried this half
 * of #4050 forward assumed `csg_manifold_gate` and `csg_topology_gate` are
 * mutually exclusive per a Cargo.toml comment. Checked directly
 * (rust/geometry/Cargo.toml, the comment above `csg_manifold_gate`): it says
 * a CENSUS RUN needs to attribute a rejection to one gate, not that Cargo (or
 * this repo's CI) refuses the pair. `.github/workflows/test.yml` runs
 * `cargo test -p ifc-lite-geometry --features
 * csg_manifold_gate,csg_topology_gate` as its own job, and
 * `rust/geometry/tests/issue_098_v5c.rs` has live
 * `#[cfg(all(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]`
 * cases. So this module does not special-case exclusivity: it reads whatever
 * combination(s) the cfg attributes actually require, including the "both
 * together" case an `all(...)` produces, and runs each combination it finds.
 *
 * SCOPE — CORRECTED. An earlier revision of this comment claimed only three
 * cfg shapes (`bare`, `any(...)`, `all(...)`) appear anywhere in this repo's
 * Rust test tree and that "nested `any(all(...))` does not occur." That is
 * false: `not(...)` nesting is live above real `#[test]` functions today —
 * `rust/geometry/tests/triangulation_invariance.rs:2168,2188` guards two
 * tests with `#[cfg(not(any(feature = "csg_topology_gate", feature =
 * "csg_manifold_gate")))]`, and `rust/geometry/src/csg/csg_tests.rs` and
 * `rust/geometry/tests/issue_582_583_regression_test.rs` each gate a test
 * with a bare `#[cfg(not(feature = "..."))]`. `rust/geometry/tests/
 * issue_098_v5c.rs:119-136` additionally shows the full cross-product —
 * `not(any(A,B))`, `all(not(A),B)`, `all(A,not(B))`, `all(A,B)` — on `const`
 * declarations (not, currently, directly above a `#[test]`, but the same
 * idiom).
 *
 * `not(...)` IS handled now, and handling it did require the caller-contract
 * change the previous revision of this note described. A whole-expression
 * `not(...)` names a run that must have those features OFF — the default
 * build — so it contributes no combo (nothing to turn ON) and
 * `parseCfgExpr` returns `[]` for it. That alone would be the old silent
 * miss, because `planRuns()` falls back to the default only when NO combo was
 * found at all: a file carrying both a `not(...)` gate and a bare
 * `#[cfg(feature = "x")]` gate would run x-only. So `requiresDefaultRun()`
 * reports that case and `planRuns()` runs the default ALONGSIDE the combos.
 *
 * This is sound only when none of the names inside the `not(...)` is a
 * DEFAULT-on feature of the crate — otherwise the default build enables it
 * and the gated test still never compiles. `planRuns()` therefore reads the
 * crate's `[features] default = [...]` and passes it down; a `not(...)` over
 * a default-on feature, or one evaluated with no known default set, still
 * throws. A `not(...)` nested inside `any(...)`/`all(...)` remains unhandled.
 * Rather than silently returning
 * `[]` for a shape it cannot correctly turn into a combo (the previous,
 * defective behavior — see `UnhandledCfgShapeError` below), this module now
 * detects `not(...)`, cfg nesting beyond one level (e.g. a hypothetical
 * `any(all(...))`), `cfg_attr(feature = "x", test)`, and an attribute sitting
 * between `#[cfg(...)]` and `#[test]`, and FAILS LOUDLY, naming the file, the
 * line, and the unhandled shape, rather than silently planning a run that
 * never compiles the gated test in. `parseCfgExpr` still reads only the
 * three shapes it always has (bare, `any(...)`, `all(...)`, none containing
 * `not(`); anything else is a `detectRequiredFeatureCombos` bug loudly
 * surfaced, never a quiet gap.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A cfg shape this module cannot turn into a feature combo — see SCOPE above. */
export class UnhandledCfgShapeError extends Error {
  constructor(shape, expr, { file = '<unknown file>', line = null } = {}) {
    const where = line != null ? `${file}:${line}` : file;
    super(`revert-oracle: unhandled cfg shape "${shape}" at ${where} (${expr}) — refusing to silently plan a run that may never compile this test in; extend detectRequiredFeatureCombos or fix the gate`);
    this.name = 'UnhandledCfgShapeError';
    this.shape = shape;
    this.file = file;
    this.line = line;
  }
}

// One extra level of paren nesting beyond a bare `#\[cfg\( ... \)\]` capture,
// so a shape like `not(any(a, b))` or `all(not(a), b)` is captured as text
// (for `checkHandledShape` to reject with a clear message) instead of simply
// failing to match at all, which is how the previous single-level pattern
// silently dropped these gates.
const NEST2 = '(?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*';
/** Whole-file gate: `#![cfg(feature = "x")]` at the top of a test file. */
export const INNER_CFG_RE = new RegExp(`#!\\[cfg\\((${NEST2})\\)\\]`, 'g');
/** Item-level gate: the `#[cfg(...)]` immediately guarding a `#[test]` fn. */
export const TEST_CFG_RE = new RegExp(`#\\[cfg\\((${NEST2})\\)\\]\\s*\\n\\s*#\\[test\\]`, 'g');
/** `#[cfg_attr(feature = "x", test)]` — a shape neither regex above matches at all. */
const CFG_ATTR_TEST_RE = /#\[cfg_attr\(([\s\S]*?),\s*test\s*\)\]/g;
/** A `#[cfg(...)]` separated from `#[test]` by one or more other attributes. */
const CFG_THEN_OTHER_ATTR_RE = new RegExp(
  `#\\[cfg\\((${NEST2})\\)\\]\\s*\\n(?:[ \\t]*#\\[(?!test\\])[^\\n]*\\]\\s*\\n)+\\s*#\\[test\\]`,
  'g',
);

/**
 * Strip `//` and `/* *\/` comments, replacing their text with spaces so
 * line/column numbers are unaffected.
 *
 * STRING-LITERAL AWARE. A regex pass that blanks from the first `//` to end
 * of line, with no notion of "am I inside a string", reads `let s = "//";
 * #[cfg(...)]` as a comment starting at the `//` INSIDE the string literal
 * and blanks everything after it on that line — including a real
 * `#[cfg(...)]` that happens to share the line. Reproduced directly against
 * this repo's shape (a `#[cfg(feature = "x")]` immediately after a `"//"`
 * string on the same line): the old regex pass dropped the gate and
 * `detectRequiredFeatureCombos` returned `[]`. This is a small single-pass
 * scanner instead, tracking whether it is inside a string/char literal so a
 * `//` or `/*` there is left alone.
 *
 * SCOPE. Handles double-quoted strings (`"…"` with `\"`/`\\` escapes), Rust
 * raw strings (`r"…"`, `r#"…"#`, `r##"…"##`, …, including the `br"…"` byte
 * form), and char literals (`'x'`, `'\n'`, `'\''`, `'\u{7f}'`), distinguished
 * from a lifetime (`'a`) by requiring a matching closing `'`. Byte strings
 * (`b"…"`) are NOT special-cased — their `\"` escaping is identical to an
 * ordinary string's, so the string-literal branch handles them correctly
 * without needing to recognize the leading `b`. This is not a full Rust
 * lexer (no raw identifiers, no nested-attribute edge cases beyond what the
 * cfg regexes downstream already assume) but a `//` inside an ordinary
 * double-quoted string — the shape actually reproduced — is common enough in
 * test fixtures to matter, so it is handled rather than disclaimed away.
 */
export function stripComments(text) {
  let out = '';
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    // Block comment, Rust-nesting aware; content (not newlines) blanked.
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { out += '  '; i += 2; depth++; continue; }
        if (text[i] === '*' && text[i + 1] === '/') { out += '  '; i += 2; depth--; continue; }
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Line comment: blank to end of line (or end of input).
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++; }
      continue;
    }

    // Raw string: r"...", r#"..."#, ..., and the byte form br"...".
    if (c === 'r' || (c === 'b' && c2 === 'r')) {
      let j = c === 'b' ? i + 1 : i;
      if (text[j] === 'r') {
        let k = j + 1;
        let hashes = 0;
        while (text[k] === '#') { hashes++; k++; }
        if (text[k] === '"') {
          const closer = `"${'#'.repeat(hashes)}`;
          const contentStart = k + 1;
          const end = text.indexOf(closer, contentStart);
          const stop = end === -1 ? n : end + closer.length;
          out += text.slice(i, stop);
          i = stop;
          continue;
        }
      }
    }

    // Ordinary (and byte) string literal: "..." with \" / \\ escapes.
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        if (text[i] === '\\' && i + 1 < n) { out += text[i] + text[i + 1]; i += 2; continue; }
        if (text[i] === '"') { out += '"'; i++; break; }
        out += text[i];
        i++;
      }
      continue;
    }

    // Char literal, e.g. 'x', '\n', '\'', '\u{7f}' — distinguished from a
    // lifetime ('a) by requiring the escape/char to be followed by a closing '.
    if (c === "'") {
      if (c2 === '\\') {
        let j = i + 2;
        if (text[j] === 'u' && text[j + 1] === '{') {
          const close = text.indexOf('}', j);
          j = close === -1 ? j : close + 1;
        } else {
          j += 1; // one char after the backslash: \n, \t, \\, \', \", \0, or the first hex digit of \xNN
          if (text[i + 2] === 'x') j = i + 4; // \xNN
        }
        if (text[j] === "'") {
          out += text.slice(i, j + 1);
          i = j + 1;
          continue;
        }
      } else if (c2 !== undefined && c2 !== "'" && text[i + 2] === "'") {
        out += text.slice(i, i + 3);
        i += 3;
        continue;
      }
      // Otherwise a lifetime or bare apostrophe — not a literal, fall through.
    }

    out += c;
    i++;
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * @param {string} expr the text inside a `cfg(...)`
 * @returns {string[][]} feature-name combinations that must be enabled
 *   TOGETHER for the expression to hold. `all(a, b)` -> `[[a, b]]`;
 *   `any(a, b)` and a bare `feature = "a"` both -> `[[a], [b]]` / `[[a]]`,
 *   since any one name alone is enough.
 * @throws {UnhandledCfgShapeError} if `expr` contains a `not(...)` or nests
 *   `any(`/`all(` beyond one level — shapes this parser does not evaluate.
 */
export function parseCfgExpr(expr, context = {}, defaultFeatures = null) {
  // A whole-expression `not(...)` holds exactly when the features it names are
  // OFF — which is the default build, and planRuns() always runs that when no
  // combo is required. So it needs no extra combo: return [].
  //
  // That is only sound when none of those names is a DEFAULT feature of the
  // crate. If one were, the default build would turn it ON and the gated test
  // would never compile in — the silent miss this module exists to prevent —
  // so that case, and an unknown default set, still fail loudly.
  const wholeNot = expr.match(/^\s*not\s*\(([\s\S]*)\)\s*$/);
  if (wholeNot) {
    if (/\bnot\s*\(/.test(wholeNot[1])) throw new UnhandledCfgShapeError('nested not(...)', expr, context);
    if (!defaultFeatures) throw new UnhandledCfgShapeError('not(...) with unknown crate defaults', expr, context);
    const onByDefault = [...wholeNot[1].matchAll(/feature\s*=\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((n) => defaultFeatures.has(n));
    if (onByDefault.length > 0) {
      throw new UnhandledCfgShapeError(`not(...) over default feature "${onByDefault[0]}"`, expr, context);
    }
    return [];
  }
  if (/\bnot\s*\(/.test(expr)) throw new UnhandledCfgShapeError('not(...)', expr, context);
  const outer = expr.match(/^\s*(any|all)\s*\((.*)\)\s*$/s);
  if (outer && /\b(any|all)\s*\(/.test(outer[2])) {
    throw new UnhandledCfgShapeError('nested any()/all() beyond one level', expr, context);
  }
  const names = [...expr.matchAll(/feature\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (outer && outer[1] === 'all') return names.length > 0 ? [names] : [];
  return names.map((n) => [n]);
}

function dedupeCombos(combos) {
  const seen = new Set();
  const out = [];
  for (const combo of combos) {
    if (combo.length === 0) continue;
    const sorted = [...combo].sort();
    const key = sorted.join(',');
    if (!seen.has(key)) { seen.add(key); out.push(sorted); }
  }
  return out;
}

/**
 * Every feature-combo this file's cfg attributes require, deduped.
 * @throws {UnhandledCfgShapeError} on `not(...)`, deeper nesting,
 *   `cfg_attr(feature = "x", test)`, or an attribute between `#[cfg(...)]`
 *   and `#[test]` — see SCOPE above for why these fail loudly instead of
 *   silently contributing no combo.
 */
export function detectRequiredFeatureCombos(text, file = '<unknown file>', defaultFeatures = null) {
  const stripped = stripComments(text);

  CFG_ATTR_TEST_RE.lastIndex = 0;
  let m = CFG_ATTR_TEST_RE.exec(stripped);
  if (m) throw new UnhandledCfgShapeError('cfg_attr(..., test)', m[0], { file, line: lineOf(stripped, m.index) });

  CFG_THEN_OTHER_ATTR_RE.lastIndex = 0;
  m = CFG_THEN_OTHER_ATTR_RE.exec(stripped);
  if (m) throw new UnhandledCfgShapeError('an attribute between #[cfg(...)] and #[test]', m[0], { file, line: lineOf(stripped, m.index) });

  const combos = [];
  for (const re of [INNER_CFG_RE, TEST_CFG_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(stripped)) !== null) {
      combos.push(...parseCfgExpr(m[1], { file, line: lineOf(stripped, m.index) }, defaultFeatures));
    }
  }
  return dedupeCombos(combos);
}

/** Union of feature-combos required across a set of repo-relative files. */
export function requiredFeatureCombos(root, relFiles, defaultFeatures = null) {
  const combos = [];
  for (const rel of relFiles) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    combos.push(...detectRequiredFeatureCombos(text, rel, defaultFeatures));
  }
  return dedupeCombos(combos);
}

/**
 * check-test-revert-oracle.mjs's dedicated exit code for an UnhandledCfgShapeError
 * that reaches planRuns() (which calls requiredFeatureCombos() above, per test
 * group, while building each cargo invocation). Defined here, not in the
 * dispatcher: check-test-revert-oracle.mjs is at its exact module-size budget
 * (see scripts/module-size-allowlist.txt) with zero headroom, so a defect found
 * in it by adversarial review (#4090) is fixed by adding logic to this
 * already-uncapped sibling instead of growing the capped file.
 *
 * WHY ITS OWN CODE. planRuns() runs at the dispatcher's module top level,
 * before its `try{}`/`uncaughtException` handler exist. Left uncaught, a cfg
 * shape this module refuses to plan a run for (see UnhandledCfgShapeError
 * above) is a genuine unhandled exception: a raw stack trace on stderr, no
 * JSON despite `--json`, and Node's default exit code of 1 — which collides
 * with the dispatcher's own EXIT_UNOBSERVED, so a CI consumer keyed on exit
 * code cannot tell "the oracle could not even plan this branch's runs" from
 * "the branch's tests ran and did not observe the change". 6 is free — the
 * dispatcher's own codes run 0 (OBSERVED) through 5 (EXIT_RESTORE_FAILED).
 */
export const EXIT_UNHANDLED_CFG_SHAPE = 6;

/** The `--json` payload for an UnhandledCfgShapeError, in the same shape the
 * dispatcher's normal report uses (verdict/reason/base/head/production/tests),
 * plus an `error` object naming what could not be planned and where. */
export function unhandledCfgShapeReport(err, base, head, production, tests) {
  return {
    verdict: 'ERROR',
    reason: err.message,
    base,
    head,
    production,
    tests,
    error: { name: err.name, shape: err.shape, file: err.file, line: err.line },
  };
}

/**
 * Run `planRuns(testPaths)`, catching UnhandledCfgShapeError so it becomes a
 * structured, distinguishable failure — die()'s ABORT formatting, JSON when
 * requested, EXIT_UNHANDLED_CFG_SHAPE — instead of an unhandled crash whose
 * exit code (Node's default 1) is ambiguous with EXIT_UNOBSERVED. Any other
 * error from `planRuns` is rethrown unchanged; this only narrows the one
 * shape this module itself can throw.
 *
 * Takes `planRuns` and `die` as parameters rather than importing them: both
 * are defined in check-test-revert-oracle.mjs (`planRuns` closes over its
 * `ROOT`; `die` closes over its restoration state), and this module has no
 * dependency on that file today. Keeping the call site there to one line —
 * matching what it replaces — is what let this defect's fix land without
 * raising that file's module-size budget.
 */
export function requiredFeaturePlanOrDie(planRuns, testPaths, json, base, head, production, die, exitCode) {
  try {
    return planRuns(testPaths);
  } catch (err) {
    if (!(err instanceof UnhandledCfgShapeError)) throw err;
    if (json) console.log(JSON.stringify(unhandledCfgShapeReport(err, base, head, production, testPaths), null, 2));
    die(exitCode, err.message);
  }
}
