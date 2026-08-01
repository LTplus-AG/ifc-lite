#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prose-versus-artifact numeral report for the moonshot bets.
 *
 * WHY THIS EXISTS. The G4 standing adversarial review
 * (docs/vision/reviews/g4-red-team-2026-07-29.md, section 6) found that five
 * of the seven things the orchestrator's verification structurally cannot
 * catch are the same thing: prose that no artifact backs. All three hard
 * catches in that review were of this class -- the code was re-run and
 * reproduced to the digit, but nobody diffed the sentences against the JSON.
 * Its named cheap fix is this script: "make every number quoted in a REPORT
 * or DESIGN emit from the scorecard JSON, and add a check that every numeral
 * in the prose appears in the artifact."
 *
 * IT GATES, AND HERE IS WHAT THAT COST. The first revision of this script was
 * report-only, on the argument that prose legitimately contains numbers no
 * artifact emits -- bars from the plan, figures re-quoted from another bet's
 * run, arithmetic done in the sentence ("43.7% of the DAG"), counts from a
 * variant run whose output was never committed -- so a strict checker would
 * flag a dozen honest lines per document and get `|| true`-d within a week.
 * That argument was right about the noise and wrong about the conclusion: a
 * report nobody is obliged to act on is how the fourth bad figure reached the
 * finishing plan. The fix was to make each of those honest lines say WHY, once,
 * next to itself (see MARKER_RE below), and then gate on the remainder. The
 * whole tree is curated to zero, `--gate` is wired into
 * .github/workflows/moonshot.yml as step E9, and the default run is still a
 * ranked report so a human can look without failing anything.
 *
 * WHAT IT SEES. Two kinds of prose set: every bet directory under
 * scripts/moonshot/ against its own artifacts, and every .md under
 * docs/vision/ -- the plans, the reviews and the spec, i.e. the gate record
 * itself -- against the union of every moonshot artifact in the tree. The
 * second kind exists because the first revision hard-coded its root to
 * scripts/moonshot and therefore structurally could not see the documents where
 * the gate record lives, which is how a wrong B4.5 figure (907 ms against a
 * committed 899) got into amendment 6 of the finishing plan in the very commit
 * that was remediating wrong figures.
 *
 * WHAT COUNTS AS BACKED. For a numeral written as `N` in the prose, the
 * tolerance is the half-ULP of its own last written digit -- 56.5 admits
 * [56.45, 56.55), so the artifact's 56.494 backs it; 2.19e-13 admits
 * +/- 0.5e-15. That is the rule a careful writer already follows, so it
 * neither invents slack nor punishes rounding. On top of that the value is
 * compared under scale factors chosen BY THE UNIT the prose wrote: x100 for a
 * percent against a stored fraction, /1e3 for seconds against milliseconds,
 * and /1e3, /1e6, /1e9 plus the three 1024 powers for byte units. So `0.0239%`
 * matches an artifact `0.023944` and `2.80 s` matches `2796`. Scales are NOT
 * applied blindly across units -- see scalesFor() for what that cost.
 * Thousands separators are stripped before parsing, so `250,582` and `250582`
 * are the same number.
 *
 * WHAT IS IGNORED, AND WHY (the false-positive controls):
 *   - fenced code blocks and inline code spans. Reproduction commands, flags,
 *     file names and type names (`f32`, `--segment 96`) are the single largest
 *     source of noise and none of them are claims.
 *   - link targets, bare URLs, HTML comments.
 *   - ISO dates (2026-07-29) and semver-shaped triples (0.8.5, 22.14.0).
 *   - ordered-list markers and numbered headings at the start of a line.
 *   - any numeral glued to a letter or underscore on either side, unless the
 *     trailing run is a known unit: B4.5, IFC4X3, ISSUE_053, node-hash-v0 and
 *     sha256 are identifiers, while 8.9x and 500ms are quantities.
 *   - a numeral whose immediately preceding word is structural: section, act,
 *     clause, phase, gate, bet, step, line, item, instrument, table, figure,
 *     version, round, tier, note, page, appendix, cycle, chapter, milestone,
 *     entry, footnote, run, commit, see, a month name, or a leading `#` / `§`;
 *     and the far end of such a range (`lines 148-171`, `line 241-243`).
 *   - a numeral hyphen-joined to a preceding word and carrying no unit, the
 *     mirror of the trailing-identifier rule: IEEE-754, mid-2027.
 * Everything else is checked. The suppressions are deliberately about SHAPE
 * (this token is not a measurement) and never about VALUE, so no rule here
 * can hide a wrong number.
 *
 * RANKING. Unbacked numerals are ordered by whether the artifact contains
 * something *close but not equal*. A prose 56.5 sitting 0.9% away from an
 * artifact 55.971 is far more likely to be a stale transcription than a prose
 * 40,028 with nothing within 10% of it anywhere in the JSON -- the latter is
 * usually a real quantity from a run that was never committed, which is worth
 * knowing but is a different problem. Near-misses are printed first, closest
 * first, and are suppressed when the neighbourhood is crowded (see
 * matchDirect) so the report never points at an unrelated field.
 *
 * DIMENSIONLESS numerals that are only explicable as a ratio over two artifact
 * values (a/b, a/b*100, percent change) get their own lower tier. It is always
 * printed, never folded into "backed", and it FAILS --gate: over a scorecard
 * with a hundred numbers those pairings land by coincidence often enough to be
 * worthless as a clearance (B4.5's genuine `8.9x` margin "explains" as the
 * percent change between two unrelated verify medians). Read that tier as "a
 * reader could plausibly have computed this in the sentence, and the checker
 * cannot tell whether they did", which is a reason to mark it, not to clear
 * it.
 *
 * KNOWN LEGITIMATE-BUT-UNBACKED CLASSES, i.e. what a `numeral-ok` marker is
 * for. None can be suppressed by a rule without also suppressing a real catch,
 * which is why each one is annotated by hand instead:
 *   - a number the prose itself is quoting in order to RETRACT it (B4.5's
 *     correction paragraph quotes the removed row's figures verbatim, and if
 *     they ever became backed that paragraph would be wrong);
 *   - prose that truncates rather than rounds a unit conversion (`36 MB` from
 *     36,536,090 B is 36.5, outside the half-ULP of "36") -- prefer fixing the
 *     prose;
 *   - a bar, budget, target or tolerance (`< 500 ms`, `< 5%`, `1e-6`);
 *   - a figure re-quoted from a DIFFERENT bet's run, or from a bet whose branch
 *     is not yet in this tree -- these self-heal, because the marker goes STALE
 *     when the artifact arrives;
 *   - a format constant or a derivation done in the document (`96 B/tuple`, the
 *     512-bit width budget);
 *   - session bookkeeping (model calls, timeouts) that no results file stores.
 * Where a number could instead be EMITTED, emit it: that is strictly better
 * than a marker, and it is what was done for B4.5's g0/g1 DAG shape rather than
 * leaving three figures excused.
 *
 * THIS IS NOT A TRUTH GATE, AND THE SCRIPT SAYS SO IN ITS OWN OUTPUT. The
 * decoy calibration below measures the only thing that matters about a green
 * run: how often a deliberately-wrong number is cleared as "backed" by
 * coincidence. Against a single curated scorecard that rate is near zero.
 * Against `docs/vision`, whose haystack is the UNION of every moonshot
 * artifact in the tree (~8,900 numbers), it is high: tens of percent, and over
 * 90% on one document. No figure is transcribed here on purpose -- the run
 * epilogue COMPUTES the docs/vision span from the run it just did, because a
 * checker that hunts stale numerals must not carry one in its own header. (The
 * 57.5%-to-91.7% figures quoted here before 2026-08-01 were measured with a
 * decoy generator that rendered every exponent-form numeral through toFixed()
 * and so tested a decoy of 0.000000.) A "backed"
 * verdict there means "some field somewhere in the program holds this value",
 * which is close to no information at all. The gate catches a figure that
 * contradicts a named artifact; it does not certify one that agrees with the
 * pile.
 *
 * THE FIX FOR THAT IS POSITIVE BINDING, NOT A BIGGER HAYSTACK. A second marker
 * form names the artifact and the JSON path a figure comes from:
 *
 *   <!-- numeral-src: 899 :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.verifyMs -->
 *
 * A bound numeral is checked against that ONE value, so its haystack is 1 and
 * its decoy pass rate is ~0 (a 3-30% perturbation cannot land inside the
 * half-ULP of a single named field). A binding that resolves and disagrees is a
 * hard finding -- the strongest check in this script, because it is the only
 * one that can say "this sentence contradicts the field it claims to quote".
 * A binding into a bet directory that is not in this tree yet is PENDING: it is
 * not counted as backed, its decoys are never cleared, and it becomes a real
 * check the moment the branch lands. A binding into a directory that DOES exist
 * but whose file or path does not is a broken binding and fails the gate.
 *
 * Usage:
 *   node scripts/moonshot/ci/check-report-numerals.mjs
 *   node scripts/moonshot/ci/check-report-numerals.mjs <dir-or-repo-root> ...
 *   node scripts/moonshot/ci/check-report-numerals.mjs --gate      # exit 1 on findings
 *                                                                 (CI: step E9)
 *   node scripts/moonshot/ci/check-report-numerals.mjs --json
 *
 * Exit codes: 0 report produced (default, whatever it found), 1 findings with
 * --gate, 2 usage/IO problem.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

const argv = process.argv.slice(2);
const GATE = argv.includes('--gate');
const AS_JSON = argv.includes('--json');
const targets = argv.filter((a) => !a.startsWith('--'));

/** Prose documents a bet is expected to keep in sync with its artifacts. */
const PROSE_NAMES = new Set(['REPORT.md', 'DESIGN.md']);
/** Not artifacts: build/config JSON that happens to sit in a bet directory. */
const JSON_IGNORE = /^(package(-lock)?|tsconfig.*|jsconfig|\.eslintrc)\.json$/;
/** Beyond this many artifact numbers the O(n^2) derived pass is skipped. */
const DERIVED_LIMIT = 600;
/**
 * Minimum digit count for a numeral embedded in an IDENTIFIER-shaped artifact
 * string (no whitespace: a name, a path, a code) to enter the haystack. Prose
 * strings and whole-string numerals are exempt -- see the walker. Without this,
 * the string "B4.5" backed a clause bar. Raising it drops real seeds and dates;
 * lowering it re-admits identifier fragments.
 */
const MIN_EMBEDDED_DIGITS = 4;
/** The gate record itself. Every .md here is prose this checker must see. */
const VISION_DIR = 'docs/vision';

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every file under `dir` down to `depth` levels. */
function walk(dir, depth = 2, out = []) {
  for (const e of listDir(dir)) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(abs, depth - 1, out);
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

const isArtifact = (f) => f.endsWith('.json') && !JSON_IGNORE.test(path.basename(f));

/**
 * A "prose set" is a group of documents plus the artifact index they are
 * checked against. There are two kinds, and the second one only exists because
 * the G4 re-review found the first one structurally blind.
 *
 * BET SETS. Any directory under `scripts/moonshot/` holding at least one prose
 * doc AND at least one non-config .json, checked against its OWN artifacts.
 * Deliberately broader than the review's literal list (`scorecard.json`,
 * `battery.json`, `results*.json`, `report*.json`): B4.4's contradicted figure
 * lives in `kernel-cross-check.json`, which none of those globs match, and a
 * checker that cannot see the artifact holding the error is not worth running.
 *
 * THE GATE RECORD. `docs/vision/**` -- the finishing plan, the execution plan,
 * the tech doc, the reviews and the spec. The first revision of this script
 * hard-coded its root to `scripts/moonshot` and therefore could not see a
 * single one of them, which is exactly how a wrong B4.5 figure (907 ms against
 * a committed 899.0 ms) reached amendment 6 of the finishing plan *in the
 * commit that was supposed to remediate wrong figures*. These documents quote
 * numbers from every bet in the program, so the artifact index they are checked
 * against is the UNION of every moonshot artifact in the tree, not any one
 * bet's. That union is large enough that the DERIVED pass is skipped and the
 * decoy calibration is poor -- both are printed, and neither weakens the only
 * thing this set is for: catching a figure that contradicts the artifact it
 * claims to come from.
 */
function findProseSets(root) {
  const base = path.join(root, 'scripts/moonshot');
  const found = [];
  const unionArtifacts = [];

  if (statSafe(base)?.isDirectory()) {
    for (const e of listDir(base)) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      const files = walk(dir);
      const prose = files.filter((f) => PROSE_NAMES.has(path.basename(f)));
      const artifacts = files.filter(isArtifact);
      unionArtifacts.push(...artifacts);
      if (prose.length > 0 && artifacts.length > 0) found.push({ dir, prose, artifacts });
    }
  }

  const vision = path.join(root, VISION_DIR);
  if (statSafe(vision)?.isDirectory()) {
    const prose = walk(vision, 3).filter((f) => f.endsWith('.md'));
    if (prose.length > 0 && unionArtifacts.length > 0) {
      found.push({ dir: vision, prose, artifacts: unionArtifacts, union: true });
    }
  }

  // An explicit directory target that is neither of the above (e.g. a single
  // bet directory passed on the command line) is checked against itself.
  if (found.length === 0 && statSafe(root)?.isDirectory()) {
    const files = walk(root);
    const prose = files.filter((f) => PROSE_NAMES.has(path.basename(f)) || f.endsWith('.md'));
    const artifacts = files.filter(isArtifact);
    if (prose.length > 0 && artifacts.length > 0) found.push({ dir: root, prose, artifacts });
  }
  return found;
}

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Artifact index
// ---------------------------------------------------------------------------

/** Every finite numeric leaf in the artifacts, with the path that produced it. */
function indexArtifacts(files) {
  const entries = [];
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      continue; // a malformed artifact is a different problem than a wrong numeral
    }
    const rel = path.basename(file);
    const visit = (node, keyPath) => {
      if (typeof node === 'number') {
        if (Number.isFinite(node)) entries.push({ v: node, src: `${rel}:${keyPath || '(root)'}` });
        return;
      }
      if (typeof node === 'string') {
        // Numbers stored as strings still count as emitted by the artifact,
        // and so do numbers EMBEDDED in a label. B4.4's battery.json records
        // its seed as `"family": "A/seed-20260727"` rather than as a numeric
        // field, and a checker that cannot see it reports the prose's seed as
        // unbacked -- a false positive created purely by where the artifact
        // chose to put the digits.
        //
        // But embedded harvesting was UNBOUNDED, and that manufactured haystack
        // entries no measurement produced. Measured on B4.5: the clause-2 bar
        // `5%` was reported BACKED by the digits of the string "B4.5" -- the
        // bet's own name vouching for the bar it is judged against. `53` cleared
        // against digits in a fixture PATH. A gate whose haystack contains the
        // identifiers of the thing being graded is not a gate.
        //
        // Two admission routes, because a digit floor alone was too blunt.
        //
        // PROSE: a string containing whitespace is a sentence, and a number a
        // sentence states is a number the artifact means. `results-tier2.json`
        // records validator errors like "base 1.1 + height 1.5 must lie within
        // [0, 2.550] (wall height 2.6 m)"; those figures are genuinely emitted
        // and must stay checkable, so drift between the design doc and the run
        // is still caught. A digit floor alone silently converted them into
        // permanent `numeral-ok` excuses -- trading a live check for an excuse,
        // which is worse than the false positive it was fixing.
        //
        // IDENTIFIER: a string with no whitespace is a name, a path or a code,
        // and its digits are usually incidental. Here a floor is right: a real
        // measurement transcribed into a label carries enough digits to be
        // worth matching (`A/seed-20260727` has 8), an identifier fragment does
        // not (`B4.5` -> 4.5, `IFC4` -> 4, and a fixture path's `053` / `10`).
        //
        // Whole-string numerals bypass both: a field holding exactly "60" is a
        // value, not a label.
        const t = node.trim();
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
          const v = Number(t);
          if (Number.isFinite(v)) entries.push({ v, src: `${rel}:${keyPath || '(root)'}` });
          return;
        }
        const isProse = /\s/.test(t);
        for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
          // Digits only, so "2.19" counts 3 and a 4-digit year counts 4.
          if (!isProse && m[0].replace(/\D/g, '').length < MIN_EMBEDDED_DIGITS) continue;
          const v = Number(m[0]);
          if (Number.isFinite(v)) entries.push({ v, src: `${rel}:${keyPath || '(root)'} (in string)` });
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((c, i) => visit(c, `${keyPath}[${i}]`));
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, c] of Object.entries(node)) visit(c, keyPath ? `${keyPath}.${k}` : k);
      }
    };
    visit(doc, '');
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Prose extraction
// ---------------------------------------------------------------------------

/**
 * INLINE MARKERS -- how a legitimately-unbacked numeral is cleared.
 *
 *   <!-- numeral-ok: 500ms, 16GB :: a bar from the plan; a machine spec -->
 *
 * The token list is written exactly as this report prints a finding
 * (`raw + unit`, thousands separators included: `1,376`, `24.27%`, `2.19e-13`,
 * `907ms`). A marker is FILE-SCOPED: it clears those tokens anywhere in the
 * document it appears in, which matches this checker's own unit of finding --
 * numerals are grouped by (raw, unit) across the file, not by line.
 *
 * WHY IN THE FILE AND NOT IN AN ALLOWLIST FILE. The defect this whole script
 * exists to catch is prose drifting away from the thing that justifies it. An
 * allowlist in a sibling directory is that defect wearing a different hat: it
 * is edited in a different commit from the sentence it excuses, it is keyed on
 * something (a line, a path) that moves, and nobody reading the claim ever sees
 * it. A marker three lines from the number appears in the same diff hunk as the
 * number, so a reviewer changing the sentence is shown the reason it was
 * excused. Markers live inside HTML comments, which maskProse() already blanks,
 * so they cannot themselves smuggle a numeral into the document.
 *
 * ANTI-ROT. An excuse must not outlive its reason, so markers are checked in
 * both directions. A marker naming a token that is now BACKED, or that no
 * longer appears in the document at all, is reported as STALE and fails
 * --gate. That is deliberate friction: when another bet's artifact lands in the
 * tree and its figures become checkable, the gate says so instead of leaving a
 * permanent hole where the check used to be.
 */
const MARKER_RE = /<!--\s*numeral-ok:\s*([\s\S]*?)\s*-->/g;

/**
 * POSITIVE BINDING -- the marker that makes a "backed" verdict mean something.
 *
 *   <!-- numeral-src: 899 :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.verifyMs -->
 *
 * `numeral-ok` says "this number is legitimately absent from the artifacts, and
 * here is why" -- it EXCUSES. `numeral-src` says "this number is field X of
 * artifact Y" -- it BINDS, and the checker then verifies exactly that. The two
 * are not interchangeable and a token may carry only one of them.
 *
 * The path is relative to `scripts/moonshot/` (a repo-relative path starting
 * `scripts/` also works). After `#` comes a dotted JSON path in the same
 * notation this report already prints for artifact values: `a.b[0].c`.
 *
 * WHY THIS FORM. `docs/vision` is checked against the union of every artifact
 * in the tree, so the question "does the program hold this number anywhere" is
 * nearly always yes -- see the decoy calibration in the header. Naming the
 * field collapses the haystack to one value, which is the difference between
 * "not contradicted" and "quoted from here". It also survives a re-bless: when
 * the artifact's field moves, the gate says which sentence quoted it.
 */
const MARKER_SRC_RE = /<!--\s*numeral-src:\s*([\s\S]*?)\s*-->/g;

function parseMarkers(rawText) {
  const out = new Map(); // token -> reason
  const bindings = new Map(); // token -> artifact reference string
  const bad = [];
  // Blank code first, so a document that DOCUMENTS the marker syntax inside a
  // code span (`<!-- numeral-ok: <token> :: <reason> -->`) does not register
  // `<token>` as a real marker. Found by this checker reporting exactly that
  // stale marker against B4.5's own explanation of the mechanism.
  const text = rawText
    .replace(/```[\s\S]*?```/g, (m2) => m2.replace(/[^\n]/g, ' '))
    .replace(/~~~[\s\S]*?~~~/g, (m2) => m2.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m2) => m2.replace(/[^\n]/g, ' '));
  for (const m of text.matchAll(MARKER_RE)) {
    const body = m[1];
    // `::` rather than `--` as the separator: a literal `--` inside an HTML
    // comment is invalid per the HTML spec and some markdown pipelines choke
    // on it, which is a silly way to break a documentation build.
    const split = body.indexOf('::');
    if (split === -1) {
      bad.push(`numeral-ok marker without a " :: <reason>": ${JSON.stringify(body.slice(0, 80))}`);
      continue;
    }
    // Split on ", " and not on ",": `25,058` is one token, and a thousands
    // separator is never followed by a space.
    const tokens = body.slice(0, split).split(/,\s+/).map((t) => t.trim()).filter(Boolean);
    const reason = body.slice(split + 2).trim();
    if (tokens.length === 0) {
      bad.push(`numeral-ok marker lists no numerals: ${JSON.stringify(body.slice(0, 80))}`);
      continue;
    }
    if (reason === '') {
      bad.push(`numeral-ok marker has an empty reason: ${JSON.stringify(body.slice(0, 80))}`);
      continue;
    }
    for (const t of tokens) out.set(t, reason);
  }
  for (const m of text.matchAll(MARKER_SRC_RE)) {
    const body = m[1];
    const split = body.indexOf('::');
    if (split === -1) {
      bad.push(`numeral-src marker without a " :: <artifact>#<json.path>": ${JSON.stringify(body.slice(0, 80))}`);
      continue;
    }
    const tokens = body.slice(0, split).split(/,\s+/).map((t) => t.trim()).filter(Boolean);
    const rest = body.slice(split + 2).trim();
    // `:: none - <why>` is the NEGATIVE binding: an assertion that no artifact
    // emits this figure. It is not the same as `numeral-ok`, which only excuses
    // a numeral the union index failed to match. A negative binding also BLOCKS
    // the union match, which is the point: a retracted figure, or a measurement
    // of the checker itself, must not be silently vindicated by a coincidental
    // hit somewhere in ~8,900 numbers. Its decoys are never cleared either, so
    // it costs the calibration nothing.
    const ref = /^none\b/i.test(rest) ? `none${rest.slice(4)}` : rest.replace(/\s+/g, '');
    if (tokens.length === 0) {
      bad.push(`numeral-src marker lists no numerals: ${JSON.stringify(body.slice(0, 80))}`);
      continue;
    }
    if (!/^none\b/i.test(ref) && !ref.includes('#')) {
      bad.push(`numeral-src marker needs <artifact>#<json.path>, got ${JSON.stringify(ref.slice(0, 80))}`);
      continue;
    }
    for (const t of tokens) {
      if (out.has(t)) {
        bad.push(`${t} carries both a numeral-ok excuse and a numeral-src binding; a token may have only one`);
        continue;
      }
      bindings.set(t, ref);
    }
  }
  return { markers: out, bindings, bad };
}

// ---------------------------------------------------------------------------
// Binding resolution
// ---------------------------------------------------------------------------

const artifactCache = new Map();

function loadArtifact(abs) {
  if (!artifactCache.has(abs)) {
    let doc = null;
    try {
      doc = JSON.parse(readFileSync(abs, 'utf-8'));
    } catch {
      doc = null;
    }
    artifactCache.set(abs, doc);
  }
  return artifactCache.get(abs);
}

/** `models[0].speedups.x` -> the number at that path, or undefined. */
function readJsonPath(doc, jsonPath) {
  let node = doc;
  for (const seg of jsonPath.match(/[^.[\]]+/g) ?? []) {
    if (node === null || node === undefined) return undefined;
    node = Array.isArray(node) && /^\d+$/.test(seg) ? node[Number(seg)] : node[seg];
  }
  if (typeof node === 'number') return Number.isFinite(node) ? node : undefined;
  if (typeof node === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(node.trim())) {
    const v = Number(node.trim());
    return Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

/**
 * A binding resolves to one of four states. PENDING is the interesting one: a
 * bet directory that is simply not in this tree yet (its branch is unmerged) is
 * a promise the checker will start enforcing the day it lands, and until then
 * the numeral is NOT counted as backed. A directory that exists with a missing
 * file or path is a typo, and typos must not hide inside PENDING.
 */
function resolveBinding(ref) {
  if (/^none\b/i.test(ref)) {
    return { status: 'none', reason: ref.slice(4).replace(/^\s*[-:]\s*/, '').trim() };
  }
  const [relRaw, jsonPath] = ref.split('#');
  const rel = relRaw.startsWith('scripts/') || relRaw.startsWith('docs/')
    ? relRaw
    : path.join('scripts/moonshot', relRaw);
  const abs = path.join(REPO_ROOT, rel);
  const betDir = path.dirname(abs);
  if (!statSafe(abs)) {
    if (!statSafe(betDir)) return { status: 'pending', rel, jsonPath };
    return { status: 'missing-file', rel, jsonPath };
  }
  const doc = loadArtifact(abs);
  if (doc === null) return { status: 'missing-file', rel, jsonPath };
  const value = readJsonPath(doc, jsonPath);
  if (value === undefined) return { status: 'missing-path', rel, jsonPath };
  return { status: 'ok', rel, jsonPath, value, src: `${path.basename(rel)}:${jsonPath}` };
}

/** Does the bound value back this numeral, under the prose's own unit scales? */
function bindingBacks(p, tol, unit, value) {
  for (const [s] of scalesFor(unit)) if (Math.abs(value * s - p) <= tol) return true;
  return false;
}

const SPACES = (n) => ' '.repeat(n);

/** Blank out a region while preserving length AND newlines, so offsets hold. */
function blank(text, re) {
  return text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

function maskProse(text) {
  let t = text;
  t = blank(t, /```[\s\S]*?```/g); // fenced code
  t = blank(t, /~~~[\s\S]*?~~~/g);
  t = blank(t, /<!--[\s\S]*?-->/g); // html comments
  t = blank(t, /`[^`\n]*`/g); // inline code
  t = blank(t, /\]\([^)\n]*\)/g); // link + image targets
  t = blank(t, /\bhttps?:\/\/\S+/g); // bare urls
  t = blank(t, /\b\d{4}-\d{2}-\d{2}\b/g); // ISO dates
  t = blank(t, /(?<![\w.])\d+\.\d+\.\d+(?![\w.])/g); // semver-shaped triples
  // Ordered-list markers and numbered headings, at line start only.
  t = t
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:[-*+]\s+)?)(\d+[.)])(\s)/.exec(line);
      if (m) return m[1] + SPACES(m[2].length) + line.slice(m[1].length + m[2].length);
      const h = /^(#{1,6}\s+)(\d+[.)]?)(\s)/.exec(line);
      if (h) return h[1] + SPACES(h[2].length) + line.slice(h[1].length + h[2].length);
      return line;
    })
    .join('\n');
  return t;
}

/** Trailing letter runs that are units rather than the rest of an identifier. */
const UNIT_SUFFIX = new Set([
  'x', 'ms', 's', 'm', 'mm', 'cm', 'km', 'kg', 'g', 'h', 'ns', 'us',
  'b', 'kb', 'mb', 'gb', 'tb', 'kib', 'mib', 'gib', 'k', 'M',
]);

/**
 * Words that make the following number a reference, not a measurement.
 * The month names are here for the same reason as the rest: `Mar 2027` and
 * `Dec 2026` are calendar references, and the finishing plan's schedule
 * section is full of them.
 */
const STRUCTURAL_WORD = new Set([
  'section', 'sections', 'act', 'acts', 'clause', 'clauses', 'phase', 'phases',
  'gate', 'gates', 'bet', 'bets', 'step', 'steps', 'line', 'lines', 'item',
  'items', 'instrument', 'instruments', 'table', 'figure', 'appendix', 'page',
  'version', 'round', 'rounds', 'tier', 'note', 'notes', 'cycle', 'cycles',
  'chapter', 'milestone', 'entry', 'footnote', 'v', 'no', 'nr', 'issue', 'pr',
  'case', 'cases', 'point', 'points', 'run', 'runs', 'workflow', 'commit',
  'see', 'per',
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may',
  'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
  'oct', 'october', 'nov', 'november', 'dec', 'december',
]);

const NUM_RE = /(?<![\w.$])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([eE][+-]?\d+)?/g;

/**
 * Characters that can open a SIGNED numeral. `NUM_RE` deliberately matches the
 * magnitude only, because folding `[+-]?` into the pattern would swallow the
 * separator of every range and date -- `lines 148-171`, `2026-07-24`,
 * `IEEE-754` -- and the range/compound suppressions below all look for that
 * separator in the text BEFORE the match. So the sign is recovered afterwards
 * and only when it is adjacent to the digits AND opened by a delimiter, which
 * is exactly the shape a written negative has and a range never does. Without
 * this, `-1.669700836e-2` was read as `+1.669700836e-2` and mismatched an
 * artifact holding the real, negative value.
 */
const SIGN_OPENER = /[\s([{,;:=<>]/;

function extractNumerals(rawText) {
  const masked = maskProse(rawText);
  // Line starts, for offset -> line number.
  const lineStarts = [0];
  for (let i = 0; i < masked.length; i += 1) if (masked[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const out = [];
  for (const m of masked.matchAll(NUM_RE)) {
    const start = m.index;
    const raw = m[0];
    const end = start + raw.length;

    // Trailing context: an identifier tail disqualifies, a unit does not.
    const tail = /^[A-Za-z_]+/.exec(masked.slice(end, end + 8));
    let unit = '';
    if (tail) {
      const word = tail[0];
      if (!UNIT_SUFFIX.has(word.toLowerCase())) continue;
      unit = word;
    } else if (masked[end] === '%') {
      unit = '%';
    } else {
      const after = /^\s?([%x]|ms|s\b|kg|MB|GB|KB|GiB|MiB|B\b)/.exec(masked.slice(end, end + 5));
      if (after) unit = after[1];
    }

    // Preceding word: structural references are not measurements.
    const beforeText = masked.slice(Math.max(0, start - 24), start);
    // A leading `#` or `§` makes it a cross-reference, not a quantity.
    if (/[#§]\s?$/.test(beforeText)) continue;
    const pw = /([A-Za-z]+)[\s]+$/.exec(beforeText);
    if (pw && STRUCTURAL_WORD.has(pw[1].toLowerCase())) continue;

    // The FAR end of a structural range: "lines 148-171", "line 241-243".
    // The rule above only reaches the near end, which left the node-hash-v0
    // spec reporting its own source-line citations as unbacked measurements.
    const rangeTail = /([A-Za-z]+)\s+\d[\d,.]*\s*[-–]\s*$/.exec(beforeText);
    if (rangeTail && STRUCTURAL_WORD.has(rangeTail[1].toLowerCase())) continue;

    // A numeral hyphen-joined to a preceding WORD is part of a compound name,
    // the mirror of the trailing-identifier rule: IEEE-754, mid-2027, IFC4X3.
    // Gated on the numeral carrying no unit, so a genuine bar written as
    // "sub-500 ms" stays checkable -- the suppression is about token shape and
    // never about value.
    if (unit === '' && /[A-Za-z]-$/.test(beforeText)) continue;

    // Sign recovery, after every suppression above has had the unsigned text
    // it expects. See SIGN_OPENER.
    const signChar = start > 0 ? masked[start - 1] : '';
    const signed =
      (signChar === '-' || signChar === '+') &&
      (start === 1 || SIGN_OPENER.test(masked[start - 2]))
        ? signChar + raw
        : raw;

    const value = Number(signed.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    out.push({ raw: signed, value, unit, line: lineOf(start) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Half the place value of the last digit actually written. */
function writtenTolerance(raw) {
  const s = raw.replace(/,/g, '');
  const em = /[eE]([+-]?\d+)$/.exec(s);
  const exp = em ? Number(em[1]) : 0;
  const mantissa = em ? s.slice(0, em.index) : s;
  const dot = mantissa.indexOf('.');
  const decimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  const tol = 0.5 * 10 ** (exp - decimals);
  return Math.max(tol, Math.abs(Number(s)) * 1e-12);
}

const BYTE_UNITS = new Set(['b', 'kb', 'mb', 'gb', 'tb', 'kib', 'mib', 'gib']);

/**
 * Scale factors are chosen by the UNIT the prose wrote, not applied blindly.
 * An earlier revision tried all fifteen against every numeral and, on a bet
 * whose artifacts hold ~3,900 numbers, that cleared almost anything: fifteen
 * scales x 3,900 values is ~58,000 chances to land inside a half-ULP window.
 * Unit-gating cuts the search to at most seven and makes a "backed" verdict
 * mean something. The decoy calibration printed with each document measures
 * what is left.
 */
function scalesFor(unit) {
  const u = unit.toLowerCase();
  const out = [[1, '']];
  if (u === '%') out.push([100, 'x100 (artifact stores the fraction)']);
  else if (u === '') out.push([100, 'x100'], [0.01, '/100 (artifact stores the percent)']);
  else if (u === 's') out.push([0.001, '/1e3 (artifact in ms)']);
  else if (u === 'ms') out.push([1000, 'x1e3 (artifact in s)']);
  else if (BYTE_UNITS.has(u)) {
    out.push(
      [1e-3, '/1e3'],
      [1e-6, '/1e6 (artifact in bytes)'],
      [1e-9, '/1e9 (artifact in bytes)'],
      [1 / 1024, '/1KiB'],
      [1 / 1048576, '/1MiB'],
      [1 / 1073741824, '/1GiB'],
    );
  }
  return out;
}

function matchDirect(p, tol, unit, index) {
  const scales = scalesFor(unit);
  let best = null;
  let crowding = 0; // artifact values within 10% at scale 1 -- see below
  for (const e of index) {
    for (const [s, label] of scales) {
      const d = Math.abs(e.v * s - p);
      if (d <= tol) return { kind: s === 1 && e.v === p ? 'exact' : 'rounded', scale: label, entry: e };
    }
    const rel = p === 0 ? (e.v === 0 ? 0 : Infinity) : Math.abs((e.v - p) / p);
    if (rel < 0.1) {
      crowding += 1;
      if (best === null || rel < best.rel) best = { rel, entry: e };
    }
  }
  // `crowding` is what makes the near-miss list readable. "The artifact holds
  // 55.971 and the prose says 56.5" is a strong hint IF 55.971 is the only
  // number in that neighbourhood. In an artifact with hundreds of timings
  // something sits within 1% of anything, and the nearest neighbour is then
  // an accident of density, not evidence. Above the threshold the numeral is
  // still reported -- it is still unbacked -- but without a misleading
  // "closest value" pointing at an unrelated field.
  const informative = best !== null && best.rel <= 0.05 && crowding <= 3;
  return { kind: null, near: informative ? best : null, crowding };
}

/** Derived explanations are offered only for DIMENSIONLESS numerals. */
const DERIVABLE_UNIT = new Set(['%', 'x', '']);

/**
 * Only ratios, and only for dimensionless quantities. Both restrictions were
 * forced by measurement rather than taste.
 *
 * Sums and differences were in the first revision and had to go: over a
 * 50-number scorecard they generate ~12,000 candidate values, enough to
 * "explain" almost any numeral within its written tolerance. They swallowed
 * B4.5's headline `56.5 ms` -- a number that genuinely does not match its
 * artifact -- which is precisely the catch this script exists to make. A rule
 * that explains the one real finding is worse than no rule.
 *
 * The dimension restriction is the same argument from the other side: `43.7%
 * of the DAG` and `8.9x margin` are arithmetic a reader does in their head, so
 * a ratio is a fair explanation. `56.5 ms` is a measurement; if it is not in
 * the artifact, no amount of dividing other people's numbers makes it so.
 */
function matchDerived(p, tol, unit, index) {
  if (!DERIVABLE_UNIT.has(unit.toLowerCase())) return null;
  if (index.length > DERIVED_LIMIT) return null;
  for (let i = 0; i < index.length; i += 1) {
    const a = index[i].v;
    for (let j = 0; j < index.length; j += 1) {
      if (i === j) continue;
      const b = index[j].v;
      if (b === 0) continue;
      if (Math.abs(a / b - p) <= tol) return { how: 'a/b', a: index[i], b: index[j] };
      if (Math.abs((a / b) * 100 - p) <= tol) return { how: 'a/b*100', a: index[i], b: index[j] };
      if (Math.abs(((a - b) / b) * 100 - p) <= tol) return { how: '(a-b)/b*100', a: index[i], b: index[j] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Calibration: how often does this checker CLEAR a number that is wrong?
// ---------------------------------------------------------------------------

/**
 * The honest way to read a "107 of 117 backed" line is to know what "backed"
 * is worth against that particular artifact set. So: take the document's own
 * numerals, perturb each by a seeded 3-30% -- far outside any rounding or unit
 * story, i.e. definitely wrong -- and re-run the matcher. Whatever fraction
 * comes back "backed" is the rate at which a genuinely wrong number would be
 * silently cleared by this checker on this bet. On a small scorecard it is
 * near zero; on an artifact set with thousands of numbers it is not, and the
 * reader is entitled to know that before trusting a clean report.
 *
 * Seeded (mulberry32) so the printed rate is reproducible run to run.
 *
 * A numeral carrying a `numeral-src` binding is calibrated against ITS OWN
 * haystack -- the single named field, or nothing at all when the binding is
 * still pending -- because that is the evidence the reader is being offered.
 * That is the whole mechanism: every figure moved from the union to a binding
 * moves three decoys from a coin flip to a certainty, and the rate falls with
 * it. `bound` / `unbound` are reported separately so the headline rate can
 * never be improved by quietly binding the easy numbers.
 */
function calibrate(groups, index, bindingIndexFor) {
  if (groups.length === 0) {
    return { decoys: 0, cleared: 0, rate: 0, bound: { decoys: 0, cleared: 0 }, unbound: { decoys: 0, cleared: 0 } };
  }
  let s = 0x9e3779b9;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let cleared = 0;
  let decoys = 0;
  const bound = { decoys: 0, cleared: 0 };
  const unbound = { decoys: 0, cleared: 0 };
  for (const g of groups) {
    const own = bindingIndexFor ? bindingIndexFor(g) : null;
    const haystack = own === null ? index : own;
    const isBound = own !== null;
    for (let k = 0; k < 3; k += 1) {
      const factor = 1 + (rnd() < 0.5 ? -1 : 1) * (0.03 + rnd() * 0.27);
      const v = g.value * factor;
      if (v === 0) continue;
      // Write the decoy at the same precision the prose used, so the tolerance
      // is the same tolerance the real numeral got.
      // Precision comes from the MANTISSA, and an exponent-form numeral stays
      // in exponent form. Reading decimals off the whole string counted the
      // exponent digits ("2.19e-13" -> 6) and then toFixed(6) collapsed the
      // decoy to "0.000000", which tests nothing: every exponent-form figure
      // in the program was being calibrated against a decoy of zero.
      const plain = g.raw.replace(/,/g, '');
      const em = /[eE][+-]?\d+$/.exec(plain);
      const mantissa = em ? plain.slice(0, em.index) : plain;
      const dot = mantissa.indexOf('.');
      const decimals = dot === -1 ? 0 : mantissa.length - dot - 1;
      const rawDecoy = em
        ? v.toExponential(Math.min(decimals, 12))
        : v.toFixed(Math.min(decimals, 12));
      decoys += 1;
      const tally = isBound ? bound : unbound;
      tally.decoys += 1;
      if (matchDirect(Number(rawDecoy), writtenTolerance(rawDecoy), g.unit, haystack).kind) {
        cleared += 1;
        tally.cleared += 1;
      }
    }
  }
  return { decoys, cleared, rate: decoys === 0 ? 0 : cleared / decoys, bound, unbound };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const roots = targets.length > 0 ? targets.map((t) => path.resolve(t)) : [REPO_ROOT];
const bets = [];
for (const r of roots) bets.push(...findProseSets(r));

if (bets.length === 0) {
  console.error(`::error::no prose set found under ${roots.join(', ')}`);
  console.error('A bet directory needs at least one of REPORT.md / DESIGN.md and one non-config .json.');
  process.exit(2);
}

const results = [];

for (const bet of bets) {
  const index = indexArtifacts(bet.artifacts);
  const betOut = {
    dir: path.relative(REPO_ROOT, bet.dir) || bet.dir,
    artifacts: bet.artifacts.map((f) => path.basename(f)),
    artifactNumbers: index.length,
    derivedPassRun: index.length <= DERIVED_LIMIT,
    docs: [],
  };

  for (const doc of bet.prose) {
    const rawText = readFileSync(doc, 'utf-8');
    const { markers, bindings, bad: badMarkers } = parseMarkers(rawText);
    const usedMarkers = new Set();
    const usedBindings = new Set();
    const nums = extractNumerals(rawText);
    const backed = [];
    const nearMiss = [];
    const noTrace = [];
    const derived = [];
    const excused = [];
    const bound = [];
    const pending = [];
    const assertedUnbacked = [];
    /** `:: none` bindings whose figure has since become backed -- see the `none` branch. */
    const staleNegativeBindings = [];
    const brokenBindings = [];

    // Group identical (value, unit) pairs so a number quoted five times is one
    // finding with five line numbers, not five findings.
    const groups = new Map();
    for (const n of nums) {
      const key = `${n.raw}|${n.unit}`;
      if (!groups.has(key)) groups.set(key, { ...n, lines: [] });
      groups.get(key).lines.push(n.line);
    }

    // Bindings first: a numeral that names its source is checked against that
    // source and nothing else, whatever the union index happens to contain.
    const boundHaystack = new Map(); // token -> 1-element index, or [] when pending
    for (const g of groups.values()) {
      const token = `${g.raw}${g.unit}`;
      const ref = bindings.get(token);
      if (!ref) continue;
      usedBindings.add(token);
      const tol = writtenTolerance(g.raw);
      const r = resolveBinding(ref);
      if (r.status === 'none') {
        boundHaystack.set(token, []);
        assertedUnbacked.push({ ...g, reason: r.reason || '(no reason given)' });
        // ADVISORY ANTI-ROT FOR THE NEGATIVE CASE, and it deliberately does
        // NOT gate. Read the reason before adding one that does.
        //
        // The gap is real: `numeral-ok` excuses are anti-rot checked, but a
        // `:: none` block is only checked for whether its token still appears
        // in the prose -- never for whether the block is still warranted. So a
        // block can assert "no artifact emits this" long after one does, and
        // the gate stays green. B4.2's re-bless turned four tokens of one such
        // marker into real fields, and that marker was what would have kept
        // `49` blocked in the merged tree, though the battery emits it exactly.
        //
        // But it CANNOT be a gate, because a value match is exactly what a
        // block is for. The retracted 1e-13 tolerance is blocked precisely
        // because a real per-family deviation falls inside its half-ULP; that
        // block working looks identical, to this check, to a block that has
        // gone wrong. Failing on it would punish the mechanism for doing its
        // job and would train the next reader to delete blocks to get green --
        // the one edit that lets a withdrawn figure become a claim again.
        //
        // So: list them, say which field matched, and let a human decide
        // whether it is still a coincidence. A list a reader must think about
        // is the honest instrument here; a gate would be a confident wrong one.
        const nowBacked = matchDirect(g.value, tol, g.unit, index);
        if (nowBacked && (nowBacked.kind === 'exact' || nowBacked.kind === 'rounded')) {
          staleNegativeBindings.push({
            token,
            reason: r.reason || '(no reason given)',
            src: nowBacked.entry ? nowBacked.entry.src : '(unknown field)',
            value: nowBacked.entry ? nowBacked.entry.v : undefined,
          });
        }
        continue;
      }
      if (r.status === 'pending') {
        boundHaystack.set(token, []);
        pending.push({ ...g, ref, rel: r.rel, jsonPath: r.jsonPath });
        continue;
      }
      if (r.status === 'missing-file' || r.status === 'missing-path') {
        boundHaystack.set(token, []);
        brokenBindings.push({
          ...g,
          ref,
          why: r.status === 'missing-file'
            ? `the bet directory exists but ${r.rel} does not parse or does not exist`
            : `${r.rel} has no numeric value at ${r.jsonPath}`,
        });
        continue;
      }
      if (!bindingBacks(g.value, tol, g.unit, r.value)) {
        boundHaystack.set(token, []);
        brokenBindings.push({
          ...g,
          ref,
          why: `the prose says ${token} and ${r.rel}#${r.jsonPath} holds ${r.value} -- outside the half-ULP of the written digit`,
        });
        continue;
      }
      boundHaystack.set(token, [{ v: r.value, src: r.src }]);
      bound.push({ ...g, ref, src: r.src, artifactValue: r.value });
    }

    for (const g of groups.values()) {
      const token = `${g.raw}${g.unit}`;
      if (bindings.has(token)) continue; // adjudicated above
      const tol = writtenTolerance(g.raw);
      const direct = matchDirect(g.value, tol, g.unit, index);
      if (direct.kind) {
        // A marker on a numeral the artifact now backs is an excuse that has
        // outlived its reason: record it so the STALE list can report it.
        if (markers.has(token)) usedMarkers.add(`${token} backed`);
        backed.push({ ...g, via: direct.kind, scale: direct.scale, src: direct.entry.src });
        continue;
      }
      if (markers.has(token)) {
        usedMarkers.add(token);
        excused.push({ ...g, reason: markers.get(token) });
        continue;
      }
      const der = matchDerived(g.value, tol, g.unit, index);
      if (der) {
        derived.push({ ...g, how: der.how, a: der.a, b: der.b });
        continue;
      }
      if (direct.near) nearMiss.push({ ...g, near: direct.near });
      else noTrace.push({ ...g, crowding: direct.crowding });
    }

    // Anti-rot: every marker must still be doing work.
    const staleMarkers = [];
    for (const [token, reason] of markers) {
      if (usedMarkers.has(token)) continue;
      staleMarkers.push({
        token,
        reason,
        why: usedMarkers.has(`${token} backed`)
          ? 'the artifact now BACKS this numeral -- delete the marker, the check covers it'
          : 'no unbacked numeral in this document matches this token -- the prose moved, delete the marker',
      });
    }
    // A binding whose numeral has left the document is the same defect: an
    // assertion about a sentence nobody can read any more.
    for (const [token, ref] of bindings) {
      if (usedBindings.has(token)) continue;
      staleMarkers.push({
        token,
        reason: ref,
        why: 'no numeral in this document matches this numeral-src binding -- the prose moved, update or delete the binding',
      });
    }

    nearMiss.sort((a, b) => a.near.rel - b.near.rel);
    noTrace.sort((a, b) => a.lines[0] - b.lines[0]);
    derived.sort((a, b) => a.lines[0] - b.lines[0]);
    excused.sort((a, b) => a.lines[0] - b.lines[0]);

    bound.sort((a, b) => a.lines[0] - b.lines[0]);
    pending.sort((a, b) => a.lines[0] - b.lines[0]);
    assertedUnbacked.sort((a, b) => a.lines[0] - b.lines[0]);
    brokenBindings.sort((a, b) => a.lines[0] - b.lines[0]);

    betOut.docs.push({
      doc: path.relative(REPO_ROOT, doc) || path.basename(doc),
      total: groups.size,
      backed: backed.length,
      backedSources: backed.map((b) => ({ token: `${b.raw}${b.unit}`, lines: b.lines, src: b.src, via: b.via })),
      bound,
      pending,
      assertedUnbacked,
      brokenBindings,
      nearMiss,
      noTrace,
      derived,
      excused,
      staleMarkers,
      staleNegativeBindings,
      badMarkers,
      decoy: calibrate(
        [...groups.values()],
        index,
        (g) => boundHaystack.get(`${g.raw}${g.unit}`) ?? null,
      ),
    });
  }
  results.push(betOut);
}

if (AS_JSON) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

let findings = 0;
const fmtLines = (lines) => (lines.length > 4 ? `L${lines.slice(0, 4).join(',')}+${lines.length - 4}` : `L${lines.join(',')}`);

console.log('Prose-versus-artifact numeral report');
console.log('====================================');
console.log('');

for (const bet of results) {
  console.log(`## ${bet.dir}`);
  console.log(
    `   artifacts: ${bet.artifacts.join(', ')} (${bet.artifactNumbers} numbers` +
      `${bet.derivedPassRun ? '' : '; DERIVED pass skipped, index too large'})`,
  );
  for (const d of bet.docs) {
    const unbacked = d.nearMiss.length + d.noTrace.length;
    // Derived-only counts as a finding. The DERIVED tier is explicitly "a hint,
    // not a clearance" -- over a scorecard with a hundred numbers those pairings
    // land by coincidence (this bet's 8.9x "explains" as a percent change
    // between two unrelated verify medians), so letting them pass --gate silently
    // would be the one place the checker clears a number it has not checked.
    findings += unbacked + d.derived.length + d.staleMarkers.length + d.badMarkers.length + d.brokenBindings.length;
    console.log(
      `   ${d.doc}: ${d.total} numerals -- ${d.backed} backed, ${d.bound.length} BOUND, ` +
        `${d.pending.length} binding pending, ${d.assertedUnbacked.length} asserted-unbacked, ` +
        `${d.excused.length} marked, ` +
        `${d.derived.length} derived-only, ${unbacked} UNBACKED`,
    );
    console.log(
      `   calibration: ${(d.decoy.rate * 100).toFixed(1)}% of ${d.decoy.decoys} ` +
        `deliberately-wrong decoys were also "backed"`,
    );
    if (d.decoy.bound.decoys > 0) {
      const bp = (d.decoy.bound.cleared / d.decoy.bound.decoys) * 100;
      const up = d.decoy.unbound.decoys === 0 ? 0 : (d.decoy.unbound.cleared / d.decoy.unbound.decoys) * 100;
      console.log(
        `                per-claim bound: ${bp.toFixed(1)}% of ${d.decoy.bound.decoys}; ` +
          `against the union index: ${up.toFixed(1)}% of ${d.decoy.unbound.decoys}`,
      );
    }
    if (d.decoy.rate > 0.25) {
      console.log(
        `   >> the BACKED count carries little information for this bet: its artifacts hold raw`,
      );
      console.log(
        `   >> sample data (dense continua of floats), so a wrong number lands next to a real one`,
      );
      console.log(
        `   >> by chance. Only the UNBACKED list is signal here. This checker earns its keep`,
      );
      console.log(
        `   >> against a curated scorecard, not against a data dump.`,
      );
    }
    if (d.brokenBindings.length > 0) {
      console.log('');
      console.log(`   BROKEN numeral-src BINDINGS (a named source that does not say what the prose says):`);
      for (const n of d.brokenBindings) {
        console.log(`     ${fmtLines(n.lines).padEnd(14)} ${(n.raw + n.unit).padEnd(14)} ${n.ref}`);
        console.log(`     ${''.padEnd(14)} ${n.why}`);
      }
    }
    if (d.nearMiss.length > 0) {
      console.log('');
      console.log(`   UNBACKED, but the artifact holds something close (ranked, closest first):`);
      for (const n of d.nearMiss) {
        console.log(
          `     ${fmtLines(n.lines).padEnd(14)} ${(n.raw + n.unit).padEnd(14)} ` +
            `closest ${n.near.entry.v} (${(n.near.rel * 100).toFixed(2)}% off) <- ${n.near.entry.src}`,
        );
      }
    }
    if (d.noTrace.length > 0) {
      console.log('');
      console.log(`   UNBACKED, no informative nearest artifact value:`);
      for (const n of d.noTrace) {
        const why = n.crowding > 3 ? ` (${n.crowding} artifact values within 10%: neighbourhood too crowded to name one)` : '';
        console.log(`     ${fmtLines(n.lines).padEnd(14)} ${n.raw + n.unit}${why}`);
      }
    }
    if (d.derived.length > 0) {
      console.log('');
      console.log(`   DERIVED-ONLY (arithmetic over two artifact values; a hit here is a hint, not a clearance):`);
      for (const n of d.derived) {
        console.log(
          `     ${fmtLines(n.lines).padEnd(14)} ${(n.raw + n.unit).padEnd(14)} ` +
            `${n.how} with a=${n.a.v} (${n.a.src}), b=${n.b.v} (${n.b.src})`,
        );
      }
    }
    if (d.badMarkers.length > 0) {
      console.log('');
      console.log(`   MALFORMED numeral-ok MARKERS:`);
      for (const b of d.badMarkers) console.log(`     ${b}`);
    }
    if (d.staleNegativeBindings.length > 0) {
      console.log('');
      console.log(`   \`:: none\` BLOCKS WITH A VALUE MATCH (advisory, does NOT fail the gate):`);
      console.log(`   >> a block whose value now appears in an artifact is USUALLY the block`);
      console.log(`   >> working -- that is what it is for. Check each one anyway: if the figure`);
      console.log(`   >> genuinely became a committed field, the block is now asserting something`);
      console.log(`   >> false and should become a positive numeral-src binding instead.`);
      for (const b of d.staleNegativeBindings) {
        console.log(`     ${b.token.padEnd(14)} an artifact value now matches this blocked numeral`);
        console.log(`     ${''.padEnd(14)} found at ${b.src}${b.value === undefined ? '' : ` = ${b.value}`}`);
        console.log(`     ${''.padEnd(14)} reason on file: ${String(b.reason).replace(/\s+/g, ' ').slice(0, 150)}`);
      }
    }
    if (d.staleMarkers.length > 0) {
      console.log('');
      console.log(`   STALE numeral-ok MARKERS (an excuse must not outlive its reason):`);
      for (const s of d.staleMarkers) {
        console.log(`     ${s.token.padEnd(14)} ${s.why}`);
        console.log(`     ${''.padEnd(14)} reason on file: ${s.reason}`);
      }
    }
    if (d.bound.length > 0) {
      console.log('');
      console.log(`   BOUND to a named field (\`<!-- numeral-src: ... :: file#json.path -->\`, haystack of 1):`);
      for (const n of d.bound) {
        console.log(`     ${fmtLines(n.lines).padEnd(14)} ${(n.raw + n.unit).padEnd(14)} ${n.artifactValue} <- ${n.ref}`);
      }
    }
    if (d.pending.length > 0) {
      console.log('');
      console.log(`   BINDING PENDING (bet directory not in this tree; NOT counted as backed, checked when it lands):`);
      for (const n of d.pending) {
        console.log(`     ${fmtLines(n.lines).padEnd(14)} ${(n.raw + n.unit).padEnd(14)} ${n.ref}`);
      }
    }
    if (d.assertedUnbacked.length > 0) {
      console.log('');
      console.log(`   ASSERTED UNBACKED (\`numeral-src: ... :: none\`; the union match is BLOCKED for these):`);
      for (const n of d.assertedUnbacked) {
        console.log(`     ${fmtLines(n.lines).padEnd(14)} ${(n.raw + n.unit).padEnd(14)} ${n.reason}`);
      }
    }
    if (d.excused.length > 0) {
      console.log('');
      console.log(`   MARKED as legitimately unbacked (\`<!-- numeral-ok: ... :: reason -->\`):`);
      for (const n of d.excused) {
        console.log(`     ${fmtLines(n.lines).padEnd(14)} ${(n.raw + n.unit).padEnd(14)} ${n.reason}`);
      }
    }
    console.log('');
  }
}

console.log('------------------------------------');
console.log(`${findings} finding(s) across ${results.length} prose set(s).`);
console.log('');
console.log('Reading this: an UNBACKED numeral is a QUESTION, not a defect. The three');
console.log('legitimate answers are (a) it is a bar or a figure from elsewhere -- mark it');
console.log('with `<!-- numeral-ok: <token> :: <reason> -->`; (b) it is arithmetic the');
console.log('reader can do -- prefer emitting it into the artifact; (c) it does not match');
console.log('the artifact -- that is the catch this exists for. The near-miss list is where');
console.log('(c) lives: a number sitting 1% from the committed value is almost always prose');
console.log('left behind by a re-run. STALE/MALFORMED markers count as findings too: an');
console.log('excuse that no longer applies is the same defect one level up.');
console.log('');
// Computed from THIS run rather than transcribed, so the one number the
// checker publishes about itself cannot go stale the way the figures it hunts
// do. Falls back to a generic sentence when no docs/vision set was scanned.
const visionRates = results
  .flatMap((b) => b.docs)
  .filter((d) => d.doc.startsWith('docs/vision') && d.decoy.decoys > 0)
  .map((d) => d.decoy.rate * 100);
const visionSpan = visionRates.length
  ? `on docs/vision this run that cleared ${Math.min(...visionRates).toFixed(1)}% to ` +
    `${Math.max(...visionRates).toFixed(1)}% of deliberately-wrong decoys. This is`
  : 'and the calibration lines above say how often that happened by chance. This is';
console.log('And read the calibration before the BACKED count. Against a union haystack a');
console.log('"backed" verdict means only that SOME field in the program holds that value --');
console.log(visionSpan);
console.log('a contradiction gate, not a truth gate. The way to make a figure actually');
console.log('checkable is `<!-- numeral-src: <token> :: <file>#<json.path> -->`, which binds it');
console.log('to one field and drops its decoy rate to ~0.');

if (GATE && findings > 0) {
  console.error(`::error::${findings} finding(s) and --gate was requested.`);
  process.exit(1);
}
process.exit(0);
