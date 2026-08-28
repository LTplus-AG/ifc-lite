#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GATE for issue #3338: "expansion is one call site every channel must
 * remember to use."
 *
 * `expandToGeometryBearingIds` (`apps/viewer/src/utils/aggregation.ts`)
 * replaces a geometry-less `IfcElementAssembly` id with its `IfcRelAggregates`
 * parts. It is reached through exactly one production entry point,
 * `cameraCallbacks.resolveHighlightIds` (wired by `Viewport.tsx`'s
 * `resolveHighlightIds` callback) -- so any code path that calls the store's
 * `isolateEntities` with ids the USER selected (a ref, a search hit, a filter
 * row, an assembly by GUID) is only correct if it routes the ids through that
 * resolver first. Nothing in the type system enforces this: `isolateEntities`
 * takes a bare `number[]`, so a channel that skips the resolver still
 * typechecks and still isolates -- it just isolates a mesh-less id, and the
 * viewport goes blank.
 *
 * This happened twice nine hours apart (#2531, #2532) with no CI run
 * containing both sides, and a fifth channel (the SDK/MCP `isolate()` call,
 * `apps/viewer/src/sdk/adapters/visibility-adapter.ts`) carried the same gap
 * until #3382. This gate exists so a SIXTH -- or a regression in one of the
 * five -- fails a CI run instead of shipping quietly. A sixth channel this
 * gate's own audit found: `apps/viewer-embed/src/bridge/handler.ts`'s
 * `ISOLATE` postMessage command (fixed alongside this gate, same PR).
 *
 * Run: `node scripts/check-isolate-expansion-routing.mjs` (also
 * `pnpm check:isolate-expansion-routing`).
 *
 * ## What counts as a channel
 *
 * Any non-test `.ts`/`.tsx` file under `apps/viewer/src` or
 * `apps/viewer-embed/src` that calls `isolateEntities(` (directly, via
 * `state.isolateEntities(`, or the optional-call form
 * `state.isolateEntities?.(`) on the viewer store's `visibilitySlice`
 * action. Test files (`*.test.ts(x)`) are excluded -- the fixtures IN this
 * gate's own test file, and the wiring tests that already pin each of these
 * five channels, would otherwise all read as new channels.
 *
 * ## Two ways to fail
 *
 * 1. UNKNOWN CHANNEL: a file calls `isolateEntities(` and is not in either
 *    allowlist below. This is the "sixth channel nobody enumerated" failure
 *    mode -- new code that isolates ids has to be triaged into one of the two
 *    lists (with a reason), not silently pass.
 * 2. LOST ROUTING: a file in `REQUIRES_ROUTING_MARKER` no longer contains a
 *    call to one of the resolvers in `ROUTING_MARKERS`. This catches a
 *    channel that HAD the fix regressing -- e.g. a refactor that inlines the
 *    handler and drops the `cameraCallbacks.resolveHighlightIds` call along
 *    the way.
 *
 * `NO_MARKER_REQUIRED` covers the other two shapes a compliant channel can
 * take: a DIFFERENT, already-verified expansion mechanism (HierarchyPanel's
 * class/type/group tabs isolate ids that `treeDataBuilder.ts` already
 * resolved to geometry-bearing members at tree-build time, via
 * `hasAggregatedGeometry`/`collectAggregatedDescendants` -- a different,
 * non-renderer-dependent path to the same correctness property), and a
 * TRACKED, IN-FLIGHT fix (an entry citing an open PR). Both need a `reason`;
 * neither is silent.
 *
 * ## LIMITATIONS -- read before assuming coverage
 *
 *  - Structural, not data-flow: "lost routing" checks that a ROUTING_MARKERS
 *    token appears ANYWHERE in the file as a call, not that its result flows
 *    into the SPECIFIC `isolateEntities(...)` argument. A file with an
 *    unrelated `resolveHighlightIds(...)` call elsewhere (e.g. a highlight
 *    handler) and a second, newly-added, unrouted `isolateEntities(rawIds)`
 *    would pass here. Every current ROUTED file's isolate handler routes
 *    through the resolver at its OWN call site (verified by reading each one
 *    while building this allowlist), so this is a real gap for a FUTURE
 *    edit, not a known miss today.
 *  - Textual match, not parsed: `ROUTING_MARKERS` and `CALL_PATTERN` are
 *    regexes over raw source. `ALIAS_DESTRUCTURE_PATTERN` closes the specific
 *    gap an adversarial review found in `isolateEntities` itself -- a
 *    destructured, renamed store binding (`const { isolateEntities:
 *    applyIsolation } = useViewerStore()`) is now flagged as a candidate even
 *    though the literal token `isolateEntities(` never appears again. The
 *    SAME gap still exists on the `ROUTING_MARKERS` side: a call spelled
 *    through a renamed local alias (`const rhi = cameraCallbacks
 *    .resolveHighlightIds; rhi(ids)`) or reached via dynamic dispatch is not
 *    detected there, and a flagged file that routes ONLY that way would read
 *    as unrouted. Not observed in the scanned tree.
 *  - Scope is `apps/viewer/src` and `apps/viewer-embed/src` only.
 *    `packages/viewer` (the separate server-side streaming HTML viewer,
 *    `viewer-html.ts`/`streaming-viewer.ts`/`server.ts`) also has an
 *    `isolateEntities` action name, but it is a completely different
 *    protocol against a plain `entityMap`/`colorOverrides` -- it has never
 *    imported `apps/viewer/src/utils/aggregation.ts` and does not share the
 *    store or `cameraCallbacks` this gate's mechanism depends on. Extending
 *    assembly expansion there is a separate feature, not a regression of
 *    this one, so it is out of this gate's scope rather than silently
 *    passed.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_ARG_INDEX = process.argv.indexOf('--root');
const ROOT =
  ROOT_ARG_INDEX !== -1 && process.argv[ROOT_ARG_INDEX + 1]
    ? process.argv[ROOT_ARG_INDEX + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

export const SEARCH_ROOTS = ['apps/viewer/src', 'apps/viewer-embed/src'];
const SOURCE_EXT = new Set(['.ts', '.tsx']);
const SKIP_DIR = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'out', '.turbo']);
const TEST_FILE = /\.test\.[jt]sx?$/;

/** A call to the visibility slice's `isolateEntities` action: `isolateEntities(`,
 *  `state.isolateEntities(`, or the optional-call form `...isolateEntities?.(`. */
export const CALL_PATTERN = /\bisolateEntities\s*\?{0,1}\.{0,1}\s*\(/;

/**
 * A binding of the store's `isolateEntities` action to a LOCAL NAME via
 * object destructuring -- `const { isolateEntities } = useViewerStore()` or,
 * critically, the aliased form `const { isolateEntities: applyIsolation } =
 * useViewerStore()`. The aliased form defeats `CALL_PATTERN`: every call
 * site afterwards reads `applyIsolation(ids)`, never the literal token
 * `isolateEntities(`, so a file that only destructures-and-renames was
 * previously invisible to this gate -- not even counted toward
 * `candidateCount`. Any destructuring of the key, aliased or not, is treated
 * as a candidate signal on its own (deliberately not narrowed to "and the
 * alias is later called": tracking a dynamic alias through the rest of the
 * file is a data-flow problem this regex-based gate cannot do reliably, and
 * a live binding to the action is itself the thing worth a reviewer's eyes
 * -- false positives here are safe, false negatives are the whole failure
 * mode this exists to close).
 */
export const ALIAS_DESTRUCTURE_PATTERN = /\bconst\s*\{[^}]*\bisolateEntities\b[^}]*\}\s*=/;

/** The resolvers that actually perform `IfcRelAggregates` expansion, or read
 *  from a resolver that does, called as real code (not merely named in prose). */
export const ROUTING_MARKERS =
  /\b(resolveHighlightIds|expandToGeometryBearingIds|expandFilterRowsThroughAggregation)\b\s*\?{0,1}\.{0,1}\s*\(/;

/**
 * Channels that MUST show a `ROUTING_MARKERS` call in the same file. Paths
 * are repo-relative, forward-slashed.
 */
export const REQUIRES_ROUTING_MARKER = new Set([
  'apps/viewer/src/components/viewer/LensPanel.tsx',
  'apps/viewer/src/components/viewer/PropertiesPanel.tsx',
  'apps/viewer/src/components/viewer/SearchModal.filter.tsx',
  'apps/viewer-embed/src/bridge/handler.ts',
]);

/**
 * Channels that call `isolateEntities(` but are not required to show a
 * `ROUTING_MARKERS` call, each with a reason a reviewer can check.
 */
export const NO_MARKER_REQUIRED = new Map([
  [
    'apps/viewer/src/components/viewer/HierarchyPanel.tsx',
    "isolates ids from getNodeElements()/node.globalIds, which treeDataBuilder.ts already " +
    'resolved to geometry-bearing members at tree-build time via hasAggregatedGeometry / ' +
    'collectAggregatedDescendants (issue #1133) -- a different, non-renderer-dependent path ' +
    'to the same correctness property, not a raw ref.',
  ],
  [
    'apps/viewer/src/sdk/adapters/visibility-adapter.ts',
    'the SDK/MCP isolate() channel: tracked and fixed by open PR #3382 ' +
    '(routes through cameraCallbacks.resolveHighlightIds), landing separately from this gate. ' +
    'Move this entry to REQUIRES_ROUTING_MARKER once #3382 merges -- until then this is a ' +
    'known, tracked gap, not a silent one.',
  ],
]);

/** Anti-vacuity floor: fewer total call sites than this means the detection
 *  regex broke (renamed action, moved directory), not that channels vanished. */
const CANDIDATE_FLOOR = 6;

/**
 * A `NO_MARKER_REQUIRED` reason below this length is treated as a stub, not
 * a justification -- e.g. `['some/File.tsx', 'x']`. This used to be checked
 * ONLY by this gate's own test file (`reason.length > 20`, an assertion
 * about the two entries that happened to exist when the test was written),
 * which is not a rule: nothing stopped a THIRD entry with a one-character
 * reason from passing CI, because `classifyFile` itself never looked at the
 * string. Enforcing it here, in the classifier, means a junk entry fails the
 * gate on its own rather than depending on a reviewer -- or a future test
 * author -- to notice.
 */
export const MIN_ALLOWLIST_REASON_LENGTH = 20;

/** @param {unknown} reason */
export function isSufficientAllowlistReason(reason) {
  return typeof reason === 'string' && reason.trim().length > MIN_ALLOWLIST_REASON_LENGTH;
}

function toPosix(p) {
  return p.split('\\').join('/');
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @param {string[]} errors unreadable subtrees are pushed here, not
 *   swallowed -- a directory this gate could not scan must fail the run
 *   loudly, not read as "clean" the same way an empty, readable directory
 *   would.
 */
export function walk(dir, out, errors) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push(`could not read directory \`${dir}\`: ${err && err.message ? err.message : err}`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      walk(join(dir, entry.name), out, errors);
    } else if (entry.isFile() && SOURCE_EXT.has(extname(entry.name)) && !TEST_FILE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

/**
 * Classify one file's content against the two allowlists. Pure -- no fs, no
 * process -- so the test file can exercise it against synthetic fixtures.
 *
 * @param {string} relPath repo-relative, forward-slashed path
 * @param {string} content file source text
 * @returns {{ isCandidate: boolean, ok: boolean, reason?: string }}
 */
export function classifyFile(relPath, content) {
  if (!CALL_PATTERN.test(content) && !ALIAS_DESTRUCTURE_PATTERN.test(content)) {
    return { isCandidate: false, ok: true };
  }
  if (NO_MARKER_REQUIRED.has(relPath)) {
    const reason = NO_MARKER_REQUIRED.get(relPath);
    if (!isSufficientAllowlistReason(reason)) {
      return {
        isCandidate: true,
        ok: false,
        reason:
          `NO_MARKER_REQUIRED entry for ${relPath} in ` +
          'scripts/check-isolate-expansion-routing.mjs carries no reviewable reason ' +
          `(got ${JSON.stringify(reason)}) -- exempting a channel from routing without a real ` +
          'justification is exactly what this allowlist exists to prevent. Write a reason ' +
          `longer than ${MIN_ALLOWLIST_REASON_LENGTH} characters explaining why this file does ` +
          'not need cameraCallbacks.resolveHighlightIds / expandToGeometryBearingIds / ' +
          'expandFilterRowsThroughAggregation.',
      };
    }
    return { isCandidate: true, ok: true, reason };
  }
  if (REQUIRES_ROUTING_MARKER.has(relPath)) {
    if (ROUTING_MARKERS.test(content)) {
      return { isCandidate: true, ok: true };
    }
    return {
      isCandidate: true,
      ok: false,
      reason:
        'calls isolateEntities( but no resolveHighlightIds / expandToGeometryBearingIds / ' +
        'expandFilterRowsThroughAggregation call was found in the file -- this known channel ' +
        'appears to have lost its assembly-expansion routing.',
    };
  }
  return {
    isCandidate: true,
    ok: false,
    reason:
      'calls isolateEntities( and is not in either allowlist (REQUIRES_ROUTING_MARKER / ' +
      'NO_MARKER_REQUIRED) in scripts/check-isolate-expansion-routing.mjs -- this looks like a ' +
      'NEW selection/isolation channel (issue #3338: "expansion is one call site every channel ' +
      'must remember to use"). Either route it through cameraCallbacks.resolveHighlightIds the ' +
      'way LensPanel/PropertiesPanel/SearchModal.filter/the embed bridge do, and add it to ' +
      'REQUIRES_ROUTING_MARKER, or -- if it genuinely does not need expansion -- add it to ' +
      'NO_MARKER_REQUIRED with a reason a reviewer can check.',
  };
}

function main() {
  const failures = [];
  const files = [];
  let scannedRoots = 0;

  for (const root of SEARCH_ROOTS) {
    const abs = join(ROOT, root);
    let st;
    try {
      st = statSync(abs);
    } catch {
      failures.push(`search root \`${root}\` does not exist under ${ROOT}.`);
      continue;
    }
    if (!st.isDirectory()) {
      failures.push(`search root \`${root}\` is not a directory.`);
      continue;
    }
    scannedRoots += 1;
    walk(abs, files, failures);
  }

  if (scannedRoots === 0) {
    console.error('\ncheck-isolate-expansion-routing: no search roots resolved -- nothing was scanned.\n');
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(
      `\ncheck-isolate-expansion-routing: 0 source files found under ${SEARCH_ROOTS.join(', ')}. ` +
      'The scan roots exist but are empty -- treated as a hard failure rather than a silent pass.\n',
    );
    process.exit(1);
  }

  let candidateCount = 0;
  const seenAllowlisted = new Set();

  for (const abs of files) {
    const rel = toPosix(relative(ROOT, abs));
    const content = readFileSync(abs, 'utf8');
    const verdict = classifyFile(rel, content);
    if (!verdict.isCandidate) continue;
    candidateCount += 1;
    if (REQUIRES_ROUTING_MARKER.has(rel) || NO_MARKER_REQUIRED.has(rel)) {
      seenAllowlisted.add(rel);
    }
    if (!verdict.ok) {
      failures.push(`${rel}: ${verdict.reason}`);
    }
  }

  if (candidateCount < CANDIDATE_FLOOR) {
    failures.push(
      `only ${candidateCount} channel file(s) calling isolateEntities( found across ${SEARCH_ROOTS.join(', ')}, ` +
      `below the floor of ${CANDIDATE_FLOOR}. That means the detection regex stopped matching ` +
      '(action renamed, files moved) rather than that channels were removed -- a gate that silently ' +
      'stops finding its own candidates would report a clean tree forever. Update CANDIDATE_FLOOR only ' +
      'after confirming channels were deliberately removed, not just that the count dropped.',
    );
  }

  if (failures.length > 0) {
    console.error('\ncheck-isolate-expansion-routing: FAILED\n');
    for (const line of failures) console.error(`  - ${line}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `check-isolate-expansion-routing: OK (${files.length} file(s) scanned, ${candidateCount} channel ` +
    `file(s) calling isolateEntities( -- ${seenAllowlisted.size} allowlisted: ` +
    `${REQUIRES_ROUTING_MARKER.size} routed, ${NO_MARKER_REQUIRED.size} exempt-with-reason)`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
