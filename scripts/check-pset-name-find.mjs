#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An IFC entity can legitimately carry two distinct property (or quantity)
 * sets that share the same name -- two `IfcRelDefinesByProperties` pointing
 * at two different "Pset_WallCommon" instances, e.g. one from the type
 * definition and one from the occurrence. Code that resolves the set with
 * `sets.find(s => s.name === name)` only ever sees the FIRST such set: if
 * the wanted property/quantity lives on the SECOND same-named set, it is
 * wrongly reported missing -- or, in a filter, the whole entity is wrongly
 * dropped from the result.
 *
 * This shape was fixed one instance at a time across six months and (at
 * last count) five call sites, each rediscovered independently: #2907,
 * #3463, and this family's own PR converted every reachable one to the
 * shared `findPropertyInSets`/`findQuantityInSets` helper in
 * `packages/query/src/pset-lookup.ts`. The point of a gate is that the
 * SHAPE stops being reachable, not that today's instances are fixed --
 * otherwise the next property lookup gets written the same way, correctly
 * following every example around it.
 *
 * WHAT THIS CATCHES: a two-step `.find` -- first `.find` locating a set by
 * `.name ===` inside a variable plausibly holding an entity's property or
 * quantity sets (its own name contains "pset"/"prop"/"qset"/"quantity", or
 * it is one of the generic names `sets`/`props`/`psets`/`qsets` used
 * throughout this family), followed (as one chained expression -- same line
 * or split across a method-chain's continuation lines -- or via an
 * intermediate variable within a few lines) by `.find` on that result's
 * `.properties`/`.quantities`, also comparing `.name ===`. Both steps are
 * required: a lone `.find(...name === ...)` on some OTHER unique-by-
 * construction list (`ifc4-pset-definitions.ts`'s definition table,
 * `COMMON_SCALES`, an enum lookup) has no second step and does not match.
 * Either callback's parameter may carry a type annotation -- `(p: any) =>`
 * and `(p: PropertySet) =>` read as the same defect as `p =>`.
 *
 * WHAT THIS DOES NOT CATCH:
 *  - A `for` loop that scans every same-named set before giving up (the
 *    CORRECT shape -- see `QueryResultEntity.getProperty` and the fixed
 *    `stats-aggregation.ts`). Only the two-`.find` collapse is a defect.
 *  - A lookup keyed by something other than `.name` (id, index).
 *  - The pattern split across MORE than a few lines, or through a
 *    function call boundary this script does not trace into.
 *  - A single `.find` with no matching second `.find` chained to
 *    `.properties`/`.quantities`. Usually that is a different, correct
 *    question (does this pset EXIST at all), which is why the gate stays
 *    quiet -- but NOT always: `deletePropertySet`/`deleteQuantitySet` in
 *    packages/mutations used a single `.find` to reach one set and then
 *    iterate ITS members, which is the same defect wearing a different
 *    shape (only the first same-named set's members got DELETE markers).
 *    Both were fixed in the PR that added this gate; the gate cannot see
 *    that shape, and widening it to every single `.find` on a pset-ish
 *    variable would flag the many legitimate existence checks. If you are
 *    reaching into a set you found by name, ask whether a SECOND set could
 *    share that name -- the gate will not ask it for you.
 *  - `*.test.ts(x)` files: a test asserting "the fixture I just built
 *    contains X" is a fundamentally different risk than a resolution path
 *    real callers depend on, and this shape is common, legitimate assertion
 *    code there (build one pset, `.find` it, check a field).
 *  - Any `.find` callback that is not `<param> => <param>.name ===` with a
 *    single, optionally type-annotated identifier parameter: a destructured
 *    parameter (`({ name }) => name === x`), a block body (`p => { return
 *    p.name === x; }`), `==` instead of `===`, or a named function passed
 *    by reference. This one is worth stating plainly because the gate was
 *    already caught by it once: as first written it required a BARE
 *    identifier, so every `(p: any) =>` site in packages/cli's query and
 *    export commands sat unflagged through the PR that added the gate and
 *    converted every other call site. A regex over callback text has no
 *    way to notice which spellings it is blind to -- only writing the
 *    variant down as a fixture does.
 * This is a deliberately NARROW pattern match, not a type-aware analysis:
 * it is scoped to catch the exact shape that has recurred, and prefers
 * missing a disguised instance over crying wolf on legitimate code.
 *
 * Run via `node scripts/check-pset-name-find.mjs` (CI: node-tests job).
 * Its own tests (`scripts/check-pset-name-find.test.mjs`) run the unmodified
 * `runCheck()` against synthetic trees, so the gate can never pass having
 * examined nothing, or fail to distinguish a real instance from a for-loop.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

/**
 * Scanned roots, deliberately NOT a bare `apps` — this must stay a subset of
 * what can actually trigger the node-tests job. `test.yml`'s filter names
 * `apps/viewer` and `apps/viewer-embed` individually rather than `apps/**`,
 * so that broadening it would not drag every landing-page edit through the
 * lane. Scanning `apps/landing` from here would make the gate read files that
 * cannot trigger it — `check-ci-path-coverage` fails on exactly that, and it
 * is right to: a gate that cannot run on a file it guards is absent there,
 * not merely weak. When a new app is added to that filter, add it here too.
 */
const SEARCH_DIRS = ['packages', 'apps/viewer', 'apps/viewer-embed', 'examples'];

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'pkg', 'build', 'coverage', '.turbo', '.next', 'target', '.git',
]);

const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE_RE = /\.test\.(ts|tsx|mts|cts)$/;

/**
 * Files with a known, still-open instance of this exact shape, left
 * unconverted deliberately because they are mid-flight in another PR this
 * family does not touch. Empty today: #3465 fixed
 * packages/query/src/entity-node.ts before this gate landed, so there is
 * nothing left to grandfather.
 *
 * Remove a row here the same PR that removes its `.find` pattern -- this
 * allowlist is meant to shrink to empty, not grow, and the staleness check
 * in runCheck() fails the gate on any row whose file no longer matches.
 */
export const KNOWN_UNFIXED = new Set([]);

/** Variable name plausibly holding an entity's property/quantity sets. */
const RISKY_VAR_RE = /^(sets|props|psets|qsets|propsets|propertysets|prop_sets|property_sets|quantitysets|quantity_sets)$/i;
function looksRisky(varName) {
  if (RISKY_VAR_RE.test(varName)) return true;
  const lower = varName.toLowerCase();
  return lower.includes('pset') || lower.includes('prop') || lower.includes('qset') || lower.includes('quantity');
}

/** How many logical lines forward to look for the second `.find` when it isn't chained inline. */
const WINDOW = 6;

/**
 * `.find(<param> => <param>.name ===` — the single fragment every pattern
 * below is built from, so widening it widens all three at once rather than
 * two of three. `group` numbers the parameter's capture group so the
 * back-reference stays correct wherever the fragment is embedded.
 *
 * The parameter may carry a TYPE ANNOTATION: `(p: any) => p.name ===` and
 * `(p: PropertySet) => p.name ===` are the same defect as `p => p.name ===`,
 * but an identifier-only pattern misses them silently. That is not
 * hypothetical — it is how `packages/cli/src/commands/export.ts` sat
 * unflagged through the very PR that added this gate and converted every
 * other call site.
 */
function findNameFragment(group) {
  return `\\.find\\(\\s*\\(?\\s*(\\w+)\\s*(?::[^)\\n]+)?\\s*\\)?\\s*=>\\s*\\${group}\\.name\\s*===`;
}

const FIND_NAME_RE = new RegExp(findNameFragment(1));

/**
 * Same-line (post continuation-merge) chain:
 * `sets.find(p => p.name === x)?.properties.find(p => p.name === y)`.
 */
const CHAIN_RE = new RegExp(
  `(\\w+)${findNameFragment(2)}[^;\\n]*?\\?\\.\\s*(properties|quantities)${findNameFragment(4)}`,
);

function safeIsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function relPath(root, full) {
  return full.slice(root.length + 1).split('\\').join('/');
}

/**
 * A chain split across physical lines (`sets\n  .find(...)\n
 * ?.properties.find(...)`) needs to read as one expression for CHAIN_RE and
 * the decl-match below to see it, so fold continuation lines (trimmed text
 * starting with `.`/`?.`) onto the previous logical statement, reporting the
 * FIRST physical line of the merged statement.
 */
function toLogicalLines(text) {
  const rawLines = text.split('\n');
  const merged = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    const isContinuation = merged.length > 0 && (trimmed.startsWith('.') || trimmed.startsWith('?.'));
    if (isContinuation) {
      merged[merged.length - 1].text += trimmed;
    } else {
      merged.push({ text: raw, line: i + 1 });
    }
  }
  return merged;
}

/** Scan one file's text for the buggy shape. Returns violation strings (empty if clean/grandfathered). */
export function scanText(rel, text, { knownUnfixed = KNOWN_UNFIXED } = {}) {
  if (knownUnfixed.has(rel)) return [];
  const found = [];
  const merged = toLogicalLines(text);

  for (let i = 0; i < merged.length; i += 1) {
    const { text: line, line: lineNo } = merged[i];

    // Case 1: chained in one expression (after continuation-line merging).
    const chainMatch = CHAIN_RE.exec(line);
    if (chainMatch && looksRisky(chainMatch[1])) {
      found.push({ rel, line1: lineNo, text1: line });
      continue;
    }

    // Case 2: `const pset = sets.find(p => p.name === x);` then, within a
    // small window, `pset.properties.find(p => p.name === y)` (optionally
    // via `pset?.properties`).
    const declMatch = /^\s*(?:const|let)\s+(\w+)\s*=\s*(\w+)\.find\(/.exec(line);
    if (!declMatch) continue;
    const [, psetVar, setsVar] = declMatch;
    if (!FIND_NAME_RE.test(line)) continue;
    if (!looksRisky(setsVar)) continue;

    const innerRe = new RegExp(
      `${psetVar}\\??\\.(properties|quantities)\\??${findNameFragment(2)}`,
    );
    for (let j = i + 1; j < Math.min(merged.length, i + 1 + WINDOW); j += 1) {
      if (innerRe.test(merged[j].text)) {
        found.push({ rel, line1: lineNo, text1: line, line2: merged[j].line, text2: merged[j].text });
        break;
      }
    }
  }

  return found;
}

/**
 * Walk `root`'s `packages/` and `apps/` trees and scan every non-test
 * TS/TSX file. Fails closed: an unreadable directory throws rather than the
 * walk silently skipping it, which would let the gate report success
 * without having looked at the file that broke the rule.
 */
export function runCheck(root, opts = {}) {
  const knownUnfixed = opts.knownUnfixed ?? KNOWN_UNFIXED;
  const searchDirs = opts.searchDirs ?? SEARCH_DIRS;
  const scanned = [];
  const violations = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`check-pset-name-find: cannot read directory ${dir}: ${err.message}`);
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && safeIsDir(full));
      if (isDir) {
        walk(full);
      } else if (SOURCE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
        const rel = relPath(root, full);
        scanned.push(rel);
        const text = readFileSync(full, 'utf8');
        violations.push(...scanText(rel, text, { knownUnfixed }));
      }
    }
  }

  if (!safeIsDir(root)) {
    throw new Error(`check-pset-name-find: root ${root} does not exist or is not a directory`);
  }
  const existingSearchDirs = searchDirs.filter((dir) => safeIsDir(join(root, dir)));
  if (existingSearchDirs.length === 0) {
    throw new Error(
      `check-pset-name-find: none of ${searchDirs.join(', ')} exist under ${root} -- nothing to scan`,
    );
  }
  for (const dir of existingSearchDirs) walk(join(root, dir));

  // An allowlist entry that no longer has the shape is worse than useless: it
  // silently exempts that file forever, so a reintroduced instance would never
  // be reported. Rescan each entry WITHOUT the allowlist and fail on any that
  // now come back clean, so the list is forced to shrink as its comment says.
  const staleAllowlisted = [];
  for (const rel of knownUnfixed) {
    const full = join(root, rel);
    // Absent under this root proves nothing — the tests scan synthetic trees
    // that contain none of the repo's real files. Only a file that IS here and
    // scans clean is provably a stale row.
    if (!existsSync(full)) continue;
    if (scanText(rel, readFileSync(full, 'utf8'), { knownUnfixed: new Set() }).length === 0) {
      staleAllowlisted.push(`${rel} (no longer matches -- delete this row)`);
    }
  }

  return {
    ok: violations.length === 0 && staleAllowlisted.length === 0,
    scanned,
    violations,
    staleAllowlisted,
    grandfathered: knownUnfixed.size,
  };
}

function formatViolation(v) {
  const where = v.line2 ? `${v.rel}:${v.line1} / :${v.line2}` : `${v.rel}:${v.line1}`;
  const snippet = v.line2 ? `${v.text1.trim()}\n    ${v.text2.trim()}` : v.text1.trim();
  return `  ${where}\n    ${snippet}`;
}

const isMain = isMainEntry(import.meta.url);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = runCheck(root);

  if (result.scanned.length === 0) {
    console.error('check-pset-name-find: scanned 0 files -- the walk is broken, not the tree clean');
    process.exit(1);
  }

  if (result.staleAllowlisted.length > 0) {
    console.error(`
KNOWN_UNFIXED rows that no longer match. The allowlist exempts a whole file, so
a stale row turns that file into a permanent blind spot for this bug. Delete
each row listed below:
`);
    for (const s of result.staleAllowlisted) console.error(`  ${s}`);
    console.error('');
  }

  if (!result.ok && result.violations.length > 0) {
    console.error(`
Two-step .find(set by name) -> .find(property/quantity by name) on what looks
like an entity's property/quantity sets. An entity can legitimately carry two
same-named sets (e.g. one from the type definition, one from the occurrence);
this pattern only ever sees the FIRST one, silently missing a property/
quantity that lives on the second. Use findPropertyInSets/findQuantityInSets
from '@ifc-lite/query' (packages/query/src/pset-lookup.ts) instead.
`);
    for (const v of result.violations) console.error(formatViolation(v) + '\n');
    process.exit(1);
  }

  if (!result.ok) process.exit(1);

  console.log(
    `check-pset-name-find: OK (${result.scanned.length} files scanned, 0 new violations, ${result.grandfathered} grandfathered)`,
  );
}
