#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GATE for issue #2944: nothing prevented a sixth unguarded entity-reference
 * walk.
 *
 * #2866 was one self-referential `IfcBooleanResult.FirstOperand` in an
 * uploaded file, and the failure mode is not a bad render -- a Rust stack
 * overflow is `SIGABRT`, not a catchable panic, so nothing upstream can turn
 * it into a load error, and in the wasm geometry worker it takes down the
 * instance. Six sites were fixed one at a time (#2868, #2869, #2870, #2871,
 * #2872, #2874) and #2873 gave the guard-CHOICE rule (AGENTS.md, "Bounding walks
 * over file-supplied references") plus the shared `MAX_MAPPED_ITEM_DEPTH` constant.
 * What neither produced is something that FAILS when a seventh walk lands
 * unguarded. That is this file.
 *
 * Run: `node scripts/check-refwalk-guards.mjs` (also `pnpm check:refwalk-guards`).
 *
 * ## What it flags
 *
 * A function is a CANDIDATE reference-following walk when either signal fires:
 *
 *   recursion -- it sits on a self- or mutual-recursion cycle in its file's
 *     local call graph, and that cycle reaches `decode_by_id` / `resolve_ref` /
 *     `resolve_ref_list`.
 *   chase     -- it contains a loop that reassigns an EXISTING (non-`let`)
 *     cursor variable from a decode/resolve call, where that same variable is
 *     also the receiver of a `.get(`/`.get_ref(` attribute read in the loop.
 *     This is the walk-expressed-as-a-loop shape, e.g. probe.rs's
 *     `extract_extrusion_direction_recursive`, which despite its name is a loop.
 *
 * A candidate FAILS the gate when no guard is in scope for it -- no
 * `visited`/`seen` set insert, no depth comparison, no bounded `0..MAX_*`
 * range. Guarded candidates pass silently and need no allowlist row, which is
 * why the allowlist is empty rather than the ~50 entries issue #2944's own
 * discussion feared: the gate keys on the GUARD, not on the site.
 *
 * ## Why cycle membership rather than "a loop around a decode call"
 *
 * The issue's literal Option 1 wording -- "a loop or self-recursion reaching
 * decode_by_id/resolve_ref without a visited or depth binding in scope" --
 * over-flags: `processors/advanced_face/edge_loop.rs` calls those functions
 * inside `for` loops at 241, 284 and 339 over a fixed list of edge ids, with
 * no guard because none is needed, and so do most of the ~55 files that call
 * them. Requiring cycle membership (or the chase-loop cursor shape) separates
 * "iterates a fixed-length list" from "follows an attribute reference that may
 * point back into an already-visited entity". Measured over all three scan
 * roots, `edge_loop.rs` is not flagged by either signal.
 *
 * ## Vacuity
 *
 * Three checks in this repo have shipped exiting 0 having examined nothing
 * (`verify-esm-entrypoints.mjs` on an unbuilt tree, `check-tla-chunk-await.mjs`
 * on an empty dist, `vitest-timeout-audit.mjs` with no arguments). This one
 * fails loudly instead: a missing scan root, a root with no `.rs` files, a
 * total candidate count below CANDIDATE_FLOOR, or a file that parses to zero
 * functions while containing an `fn` are each a hard failure. CANDIDATE_FLOOR
 * is the anti-vacuity assertion that matters -- a detector that silently stops
 * matching (a regex edited, a helper renamed) drops to zero candidates and
 * would otherwise report a clean tree.
 *
 * ## Verified against the history it exists to prevent a repeat of
 *
 * Run at each of the six #2866 fixes and at each fix's PARENT commit, over the
 * three scan roots. Five of six: the parent is reported unguarded at the exact
 * function the fix guards, and the fix commit clears it.
 *
 *   #2868 5d54de032 -> f297186c9  wasm-bindings/.../color.rs find_color_for_geometry  DETECTED
 *   #2869 27c6d9962 -> de35ee126  processing/.../symbolic/items.rs extract_symbolic_item  DETECTED
 *   #2870 64bf7d4be -> 8c2a484ba  geometry/.../boolean/mod.rs <-> csg_primitive.rs        MISSED
 *   #2871 f297186c9 -> e543131ff  geometry/.../advanced_face/polyline.rs sample_curve_polyline  DETECTED
 *   #2872 de35ee126 -> 159c93b0a  geometry/.../router/layers.rs item_has_identity_position  DETECTED
 *   #2874 066ca8df9 -> 94a2812a9  geometry/.../processors/surface.rs (2-fn cycle)          DETECTED
 *
 * The fixes landed interleaved, so a commit still reporting OTHER sites
 * unguarded is expected -- those were fixed by a later commit in the list.
 *
 * #2870 is the honest miss and it is the blind spot below, not bad luck:
 * `BooleanClippingProcessor` (boolean/mod.rs) routes its `IfcCsgSolid` operand
 * through `CsgSolidProcessor` (csg_primitive.rs), which constructs a fresh
 * `BooleanClippingProcessor`. The cycle spans two files, and the call graph
 * here is per-file.
 *
 * ## LIMITATIONS -- read before assuming coverage
 *
 * Both signals are lexical and single-file. Specifically:
 *
 *  - CAUGHT: direct self-recursion; mutual recursion between functions in the
 *    SAME file (via an `_inner`/`_guarded` helper, the shape five of the six
 *    #2866 fixes use); a walk expressed as a cursor-reassigning loop.
 *  - NOT CAUGHT: mutual recursion ACROSS files or crates. Measured, not
 *    hypothetical -- it is why #2870 is missed above. Keying the call graph on
 *    bare function names repo-wide was rejected rather than untried: every
 *    processor in `rust/geometry/src/processors` defines `fn process`, so a
 *    global name-keyed graph makes one giant spurious cycle out of them. A
 *    real fix needs type resolution (`syn`), which is a different tool than
 *    this.
 *  - NOT CAUGHT: a walk that reaches the decode through a trait object, a
 *    closure stored in a struct, or any dynamic dispatch -- callee names are
 *    matched textually.
 *  - NOT CAUGHT: a walk that reads raw bytes instead of calling
 *    `decode_by_id`/`resolve_ref`. `rust/geometry/src/router/content_hash.rs`'s
 *    `sig_entity` is exactly that, deliberately, for cost reasons. Verified by
 *    running: this gate produces zero candidates for that file, so its
 *    `depth > MAX_DEPTH` cap and memo are held in place by nothing here.
 *  - WEAK: guard DETECTION is presence-of-shape, not correctness. A `visited`
 *    set that is inserted into but never consulted, a depth counter never
 *    incremented, or the WRONG guard for the site (#2872's first attempt used
 *    a depth cap on an eligibility probe and silently dropped layer slicing on
 *    files that render today, because #960 records Revit chains 42 nodes deep)
 *    all read as guarded here. Choosing between a global visited set, a
 *    path-scoped one and a depth cap stays a review question -- AGENTS.md has
 *    the decision procedure. This gate only asserts that SOMETHING is there.
 *    The false-GUARD direction is the one that has actually bitten: an
 *    unrelated `for i in 0..=SEGMENTS` tessellation loop read as a depth cap
 *    and hid #2869's walk until the constant was required to name a bound.
 *  - WEAK: the chase signal is co-occurrence. A loop that reassigns a cursor
 *    from a decode call for one reason while separately reading `.get(...)`
 *    off the same variable name for an unrelated reason would false-positive.
 *    Not observed in the scanned tree.
 *  - NOT CAUGHT: a function named the same as a local one but belonging to an
 *    unrelated impl block, reached via `self.field.name(...)`, is deliberately
 *    NOT read as self-recursion (that fix removed five false positives on
 *    `process` methods). The converse residual stands: `self.name(...)` where
 *    `name` is a trait method that merely shares a name with a local function
 *    would be misread as recursion.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFunctions, findWalkCandidates } from './lib/refwalk-classify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Scan roots. Issue #2944 names only `rust/geometry/src`, and its last open
 * question was crate-scope vs pattern-scope. Scoped to the PATTERN here, and
 * the history says that is the right call: of the six #2866 fixes, #2869's
 * site is `rust/processing/src/symbolic/items.rs` and #2868's is
 * `rust/wasm-bindings/src/api/styling/color.rs`. A gate scoped to the crate
 * the issue names would have been blind to two of the six walks it exists to
 * prevent a seventh of. Both extra roots cost nothing: each contributes zero
 * unguarded candidates today.
 */
const SCAN_ROOTS = ['rust/geometry/src', 'rust/processing/src', 'rust/wasm-bindings/src'];

/**
 * Lower bound on how many candidate walks the two signals must still find.
 * NOT a ceiling on unguarded ones (that bound is zero, enforced separately) --
 * this exists so the gate cannot pass by having stopped detecting anything.
 * If a real refactor removes walks, lower this in the same commit, which makes
 * "this PR reduced the gate's reach" a reviewable line in the diff.
 *
 * Measured at 35 on cc09ad8c1 (29 recursion + 6 chase) across the three scan
 * roots. Set to 30, a small margin so ordinary churn does not force an edit,
 * while a broken detector -- every break measured while building this dropped
 * the count to zero or near it -- still fails.
 */
const CANDIDATE_FLOOR = 30;

/**
 * Allowlist for candidates that are genuinely unguarded and must stay that
 * way. EMPTY, and expected to stay empty: every walk in the scanned tree is
 * guarded today, so a row here is a deliberate statement that a file-driven
 * walk may recurse without bound. Format, one per line:
 *
 *   <path>::<function>::<signal>  # reason, and what would let it be removed
 *
 * A row whose candidate no longer fires is reported as stale and fails, so
 * entries cannot rot: the way one is removed is that the walk gets a guard (or
 * stops being a walk), and the next run tells you to delete the line.
 */
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'refwalk-guard-allowlist.txt');

/**
 * Exact allowlist size, recorded here rather than in the allowlist: a ceiling
 * derived from the file it guards is circular and always passes. Both
 * directions fail, so growth must show up as an edit to this line.
 */
const ALLOWLIST_CEILING = 0;

/**
 * Fails closed on an unreadable directory: swallowing it would let the gate
 * report success without having looked at the file that broke the rule.
 *
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'target') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.rs')) out.push(full);
  }
  return out;
}

/**
 * @param {string} path
 * @returns {Set<string>}
 */
function loadAllowlist(path) {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean)
  );
}

/**
 * The whole check, as a function of a base directory, so its own tests can run
 * it against a synthetic tree instead of the repo.
 *
 * @param {string} base
 * @param {{ roots?: string[], allowlist?: Set<string>, candidateFloor?: number, allowlistCeiling?: number }} [opts]
 * @returns {{ ok: boolean, errors: string[], candidates: number, unguarded: string[], files: number }}
 */
export function runCheck(base, opts = {}) {
  const roots = opts.roots ?? SCAN_ROOTS;
  const allowlist = opts.allowlist ?? loadAllowlist(ALLOWLIST_PATH);
  const candidateFloor = opts.candidateFloor ?? CANDIDATE_FLOOR;
  const allowlistCeiling = opts.allowlistCeiling ?? ALLOWLIST_CEILING;

  const errors = [];
  const unguarded = [];
  const stale = new Set(allowlist);
  let candidates = 0;
  let files = 0;

  for (const root of roots) {
    const abs = join(base, root);
    if (!existsSync(abs)) {
      errors.push(
        `scan root missing: ${root}. The gate has nothing to check, which is a failure, not a pass — fix the path or remove the root.`
      );
      continue;
    }
    const found = walk(abs);
    if (found.length === 0) {
      errors.push(`scan root ${root} contains no .rs files. Refusing to report success on an empty input set.`);
      continue;
    }
    files += found.length;
    for (const file of found) {
      const rel = relative(base, file).split('\\').join('/');
      const text = readFileSync(file, 'utf8');
      // A file that plainly defines functions but parses to none means the
      // extractor broke on it. Silently classifying it as clean is exactly the
      // vacuous-pass shape this gate must not have.
      if (extractFunctions(text).length === 0 && /\bfn\s+[A-Za-z_]/.test(text)) {
        errors.push(`${rel}: contains \`fn\` but parsed to zero functions — the extractor failed on this file.`);
        continue;
      }
      for (const c of findWalkCandidates(text)) {
        candidates++;
        if (c.guard) continue;
        const key = `${rel}::${c.name}::${c.signal}`;
        if (allowlist.has(key)) {
          stale.delete(key);
          continue;
        }
        unguarded.push(key + (c.cycle.length > 1 ? `  (cycle: ${c.cycle.join(' <-> ')})` : ''));
      }
    }
  }

  if (candidates < candidateFloor) {
    errors.push(
      `only ${candidates} candidate walks found, floor is ${candidateFloor}. Either the detector stopped working (check scripts/lib/refwalk-classify.mjs) or walks were genuinely removed — if removed, lower CANDIDATE_FLOOR in the same commit.`
    );
  }
  if (stale.size > 0) {
    errors.push(
      `allowlist entries that no longer name an unguarded walk (guarded, renamed or deleted — remove the lines):\n  ${[...stale].join('\n  ')}`
    );
  }
  if (allowlist.size !== allowlistCeiling) {
    errors.push(
      `allowlist has ${allowlist.size} entries but ALLOWLIST_CEILING reads ${allowlistCeiling}. Adding a row is a deliberate loosening of this gate and must be visible in review: edit the constant in the same commit. Removing one must lower it, or the ceiling drifts into slack.`
    );
  }

  return { ok: errors.length === 0 && unguarded.length === 0, errors, candidates, unguarded, files };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const result = runCheck(ROOT);
  if (result.unguarded.length > 0) {
    console.error('\nUnguarded file-driven entity-reference walks:\n');
    for (const u of result.unguarded) console.error(`  ${u}`);
    console.error(`
Each of these follows an entity reference supplied by the uploaded file, in a
cycle or a cursor loop, with no visited/seen set and no depth cap in scope. A
self-referential reference in a malformed or hostile file recurses until the
Rust stack overflows, which is SIGABRT — not a catchable panic, and in the wasm
geometry worker it takes down the whole instance (#2866).

Add a guard. Which one is NOT interchangeable: see AGENTS.md, "Bounding walks over
file-supplied references". Briefly — a GLOBAL visited set where the recursion is
a pure lookup (the answer is a function of the id alone), a PATH-scoped set
where the recursion accumulates (the same node down two branches is two real
pieces of geometry, and a global set silently drops the second), and a depth cap
IN ADDITION where a long acyclic chain can still blow the stack. Do not put a
depth cap on an eligibility probe: #960 records Revit chains 42 DIFFERENCE nodes
deep, and capping one silently drops geometry that renders today.

Use ifc_lite_core::limits::MAX_MAPPED_ITEM_DEPTH rather than a fresh \`= 32\`.
`);
  }
  for (const e of result.errors) console.error(`\nrefwalk-guards: ${e}`);
  if (!result.ok) process.exit(1);
  console.log(
    `check-refwalk-guards: OK (${result.files} .rs files scanned, ${result.candidates} candidate walks, all guarded, 0 unguarded)`
  );
}
