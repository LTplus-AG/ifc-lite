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
 * until #3382. A sixth channel this gate's own audit found:
 * `apps/viewer-embed/src/bridge/handler.ts`'s `ISOLATE` postMessage command
 * (fixed alongside this gate, same PR).
 *
 * A SEVENTH channel surfaced after this gate shipped, from an adversarial
 * review of the gate itself: `apps/viewer-embed/src/components/
 * useEmbedUrlParams.ts`'s `?isolate=` handler calls `setIsolatedEntities(`,
 * never `isolateEntities(` -- the visibility slice's other raw-id isolation
 * actuator (ASSIGNS instead of TOGGLING; see `SET_ISOLATED_CALL_PATTERN`).
 * A gate that only watched one of the two sibling actions let a channel
 * dodge it for free by picking the other one, so the gate now watches both
 * (`RAW_ISOLATION_ACTIONS`), and every OTHER direct `setIsolatedEntities`
 * caller was audited at the same time -- see `REQUIRES_ROUTING_MARKER` and
 * `NO_MARKER_REQUIRED` below for what each one turned out to need.
 *
 * Run: `node scripts/check-isolate-expansion-routing.mjs` (also
 * `pnpm check:isolate-expansion-routing`).
 *
 * ## What counts as a channel
 *
 * Any non-test `.ts`/`.tsx` file under `apps/viewer/src` or
 * `apps/viewer-embed/src` that calls `isolateEntities(` or
 * `setIsolatedEntities(` (directly, via `state.`, the optional-call form
 * `?.(`, a destructured/aliased local binding of either (`const {
 * isolateEntities: apply } = ...`, including `let`/reassignment and
 * function-parameter destructuring -- see `ALIAS_DESTRUCTURE_PATTERN`), or a
 * plain member-access rebinding (`const apply = state.isolateEntities;` --
 * see `PROPERTY_ALIAS_PATTERN`) on the viewer store's `visibilitySlice`.
 * Test files (`*.test.ts(x)`) are excluded -- the fixtures IN this gate's
 * own test file, and the wiring tests that already pin each of these seven
 * channels, would otherwise all read as new channels.
 *
 * ## Two ways to fail
 *
 * 1. UNKNOWN CHANNEL: a file calls `isolateEntities(` or `setIsolatedEntities(`
 *    and is not in either allowlist below. This is the "a channel nobody
 *    enumerated" failure mode -- new code that isolates ids has to be
 *    triaged into one of the two lists (with a reason), not silently pass.
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
 *  - "Textual match, not parsed" cuts both ways: a demonstrated instance was
 *    that a call-SHAPED fragment inside a line comment, a block comment, or a
 *    string literal (`// cameraCallbacks.resolveHighlightIds(ids)`, or the same
 *    text quoted as `"resolveHighlightIds(ids)"`) satisfied `ROUTING_MARKERS`
 *    even though no such call executes -- exactly the false GREEN this gate
 *    exists to prevent (a routing call commented out during a refactor would
 *    read as "still routed"). `classifyFile` now runs every pattern above
 *    against `stripCommentsAndStrings(content)` rather than raw `content` to
 *    close that. That stripper is itself a naive, non-parsing pass -- see its
 *    own doc comment for exactly what it does and does not handle (regex
 *    literals, escaped-quote parity, template-literal interpolations). It
 *    does not change the two gaps above: a real call reached only through a
 *    renamed alias, or a real call in an unrelated part of the file, is still
 *    invisible/insufficiently-precise the same way.
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
import { isMainEntry } from './lib/is-main-entry.mjs';

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
 * A call to `setIsolatedEntities(`, the visibility slice's OTHER raw-id
 * isolation actuator. `isolateEntities` TOGGLES a same-set channel;
 * `setIsolatedEntities` ASSIGNS it -- used by every channel that must not
 * self-cancel on a re-run (an embed URL param applied once, a preview that
 * re-syncs on every change, a BCF viewpoint, a clash/IDS focus). Both take a
 * bare id collection with no expansion, and both blank the viewport the same
 * way on a geometry-less assembly id (#2531/#2532's failure mode) -- a
 * gate that only watched `isolateEntities` let a channel dodge it for free
 * simply by picking this sibling action, which is exactly how
 * `apps/viewer-embed/src/components/useEmbedUrlParams.ts` (#3338) went
 * unnoticed: `grep -c "isolateEntities("` on that file is 0.
 */
export const SET_ISOLATED_CALL_PATTERN = /\bsetIsolatedEntities\s*\?{0,1}\.{0,1}\s*\(/;

/** The store actions this gate treats as "raw isolation" -- see
 *  `CALL_PATTERN` and `SET_ISOLATED_CALL_PATTERN`. Exported so a future
 *  third sibling action can be found by grepping for this list's use. */
export const RAW_ISOLATION_ACTIONS = ['isolateEntities', 'setIsolatedEntities'];

/**
 * A binding of either raw-isolation action (`RAW_ISOLATION_ACTIONS`) to a
 * LOCAL NAME via object destructuring -- `const { isolateEntities } =
 * useViewerStore()` or, critically, the aliased form `const {
 * isolateEntities: applyIsolation } = useViewerStore()`. The aliased form
 * defeats `CALL_PATTERN`/`SET_ISOLATED_CALL_PATTERN`: every call site
 * afterwards reads `applyIsolation(ids)`, never the literal action name, so
 * a file that only destructures-and-renames was previously invisible to
 * this gate -- not even counted toward `candidateCount`. Any destructuring
 * of either key, aliased or not, is treated as a candidate signal on its own
 * (deliberately not narrowed to "and the alias is later called": tracking a
 * dynamic alias through the rest of the file is a data-flow problem this
 * regex-based gate cannot do reliably, and a live binding to either action
 * is itself the thing worth a reviewer's eyes -- false positives here are
 * safe, false negatives are the whole failure mode this exists to close).
 *
 * Originally anchored to `const { ... } =` only. Widened (adversarial
 * self-review of this gate, issue #3338) after noticing the anchor missed
 * two shapes that rename or rebind an action just as effectively:
 *   - `let`/`var`, or no declaration keyword at all -- a destructuring
 *     REASSIGNMENT (`({ isolateEntities } = something)`) uses no keyword,
 *     and nothing about the bypass requires `const`.
 *   - destructuring in FUNCTION PARAMETER position -- `function
 *     onIsolate({ isolateEntities: apply }: VisibilitySlice) { apply(ids) }`
 *     binds a local alias the same way a `const` destructure does, but the
 *     brace is followed by `)` or a type annotation, never `=`.
 * The pattern below drops the keyword requirement and accepts the brace
 * being followed by `=`, `)`, or `:` (a nested destructure target, or a
 * parameter's type annotation), while still requiring `[^{}]` instead of
 * `[^}]` so it cannot cross into an unrelated outer scope (e.g. an
 * `interface { isolateEntities: (ids: number[]) => void; ...many fields... }`
 * declaration, which has no closing `}` anywhere near this one field).
 */
export const ALIAS_DESTRUCTURE_PATTERN =
  /\{[^{}]*\b(?:isolateEntities|setIsolatedEntities)\b[^{}]*\}\s*[=):]/;

/**
 * A PLAIN (non-destructured) rebinding of either raw-isolation action to a
 * local name via member access -- `const apply = state.isolateEntities;`
 * or `const apply = store.getState().setIsolatedEntities;` -- followed
 * later by `apply(ids)`. This defeats both `CALL_PATTERN`/
 * `SET_ISOLATED_CALL_PATTERN` (no literal `isolateEntities(` remains) AND
 * `ALIAS_DESTRUCTURE_PATTERN` (no `{ }` destructuring syntax at all), so a
 * new channel written this way was invisible to every earlier version of
 * this gate. Matches the property-access form immediately after `=`,
 * regardless of what precedes the property name; a false positive (e.g.
 * assigning the function without ever calling it) is safe for the same
 * reason `ALIAS_DESTRUCTURE_PATTERN`'s false positives are.
 */
export const PROPERTY_ALIAS_PATTERN =
  /=\s*[\w$]+(?:\([^()]*\))?(?:\??\.[\w$]+(?:\([^()]*\))?)*\.(?:isolateEntities|setIsolatedEntities)\b/;

/** The resolvers that actually perform `IfcRelAggregates` expansion, or read
 *  from a resolver that does, called as real code (not merely named in prose).
 *  `resolveIsolationIds` (`apps/viewer/src/lib/isolation/resolveIsolationIds.ts`,
 *  #3338) is the shared policy wrapper most isolation channels now
 *  call INSTEAD of `resolveHighlightIds` directly -- it takes the resolver
 *  as its first argument rather than invoking it inline, so a channel that
 *  switched to it no longer contains the literal `resolveHighlightIds(`
 *  call this pattern used to require. (`PropertiesPanel.tsx` and
 *  `SearchModal.filter.tsx` still call the resolver inline on purpose, each
 *  with its own reason in the source -- both spellings must keep passing.) */
export const ROUTING_MARKERS =
  /\b(resolveHighlightIds|expandToGeometryBearingIds|expandFilterRowsThroughAggregation|resolveIsolationIds)\b\s*\?{0,1}\.{0,1}\s*\(/;

/**
 * Channels that MUST show a `ROUTING_MARKERS` call in the same file. Paths
 * are repo-relative, forward-slashed.
 */
export const REQUIRES_ROUTING_MARKER = new Set([
  'apps/viewer/src/components/viewer/LensPanel.tsx',
  'apps/viewer/src/components/viewer/PropertiesPanel.tsx',
  'apps/viewer/src/components/viewer/SearchModal.filter.tsx',
  'apps/viewer-embed/src/bridge/handler.ts',
  // A SEVENTH channel found by widening CALL_PATTERN to setIsolatedEntities
  // (a real bug, not hypothetical): `?isolate=` named a geometry-less
  // assembly and blanked the viewport, because this hook calls the
  // ASSIGNING `setIsolatedEntities`, never `isolateEntities` -- invisible to
  // every earlier version of this gate.
  'apps/viewer-embed/src/components/useEmbedUrlParams.ts',
  // Audited alongside the seventh channel (all five other setIsolatedEntities
  // callers, per the review that found #useEmbedUrlParams.ts): a BCF
  // viewpoint's visible-component exceptions can name whatever the
  // AUTHORING tool recorded, not guaranteed geometry-bearing in this
  // renderer.
  'apps/viewer/src/hooks/useBCF.ts',
  // The IDS row-focus isolate (`installFocusIsolation`) and set-level
  // isolate (`installSetIsolation`, the failed/passed/involved buttons):
  // both isolate ids an IDS specification's applicability filter matched,
  // which can be any IFC class, including a geometry-less assembly -- the
  // same shape as LensPanel/SearchModal.filter's rule-matched ids.
  'apps/viewer/src/hooks/useIDS.ts',
  // The SDK/MCP isolate() channel: #3382 landed the routing fix and #3338
  // moved its union policy into the shared `resolveIsolationIds`, so this
  // now genuinely routes and belongs here instead of NO_MARKER_REQUIRED.
  'apps/viewer/src/sdk/adapters/visibility-adapter.ts',
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
    'apps/viewer/src/hooks/useClash.ts',
    'installClashIsolation only ever receives a clash PAIR\'s element refs (clash.a.ref / ' +
    'clash.b.ref), and clash detection tests actual mesh triangles for intersection -- an ' +
    'element without geometry can never appear in a clash result, so these ids are always ' +
    'geometry-bearing by construction, not a raw user pick that needs expansion.',
  ],
  [
    'apps/viewer/src/components/viewer/anonymized-export/usePreviewIsolation.ts',
    "the 3D preview's contract is to MIRROR the export's `includedIds` exactly, not to isolate " +
    'what a user picked -- a geometry-less container in that set draws nothing because the export ' +
    'genuinely contains no geometry for it, which is the truth the preview is there to show. ' +
    "Expanding it would be inert under the shipped defaults (`related-entities.ts` walks " +
    "`IfcRelAggregates` 'both', so an included container's renderable parts are already in the " +
    'set) and actively wrong when the user turns that walk off or unchecks a part: the preview ' +
    'would then show geometry the exported file does not contain.',
  ],
  [
    'apps/viewer/src/lib/tours/tours/ids.ts',
    'the tour cleanup only ever calls setIsolatedEntities(null) to release an isolation the ' +
    'tour installed elsewhere -- null clears the channel and has nothing to expand, and this ' +
    'file never installs a non-null set of its own.',
  ],
  [
    'apps/viewer/src/store/slices/visibilitySlice.ts',
    'this IS the definition site of both isolateEntities and setIsolatedEntities (the actions ' +
    'this gate polices, not a caller of them) -- the only textual match is a doc comment ' +
    'describing another channel\'s restore sequence ("... went setIsolatedEntities(null) ..."), ' +
    'and the file itself never installs a raw id set into a resolver-dependent channel.',
  ],
]);

/** Anti-vacuity floor: fewer total call sites than this means the detection
 *  regex broke (renamed action, moved directory), not that channels vanished.
 *  Raised from 6 to 13 when `SET_ISOLATED_CALL_PATTERN` widened the scan to
 *  `setIsolatedEntities` (seven new real candidates: the seventh channel
 *  itself plus the six audited direct callers) -- the real tree scans clean
 *  at 13 as of this change; lower it only after confirming channels were
 *  deliberately removed, never just because the count dropped.
 *  Lowered from 13 to 12 when `classifyFile` started scanning
 *  `stripCommentsAndStrings(content)` instead of raw source: this floor's OWN
 *  NO_MARKER_REQUIRED entry for `visibilitySlice.ts` already documented that
 *  "the only textual match is a doc comment" there (a `setIsolatedEntities(
 *  null)` mention describing a DIFFERENT channel's restore sequence, not a
 *  call in this file). Stripping comments correctly removes that false
 *  candidate rather than a real channel disappearing -- confirmed by rereading
 *  the file, not by the count alone. */
const CANDIDATE_FLOOR = 12;

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
 * Strip line comments (`//` to end of line), block comments (`/*` to `*​/`),
 * and single/double/backtick string-literal bodies out of `content`, so the
 * patterns above run against something closer to executable code than raw
 * text. Every removed character is replaced with a space (a removed newline
 * stays a newline) so positions and line numbers are unaffected -- nothing
 * here currently reports a line number, but nothing should have to change if
 * something later does.
 *
 * This closes a demonstrated false GREEN: `ROUTING_MARKERS` and `CALL_PATTERN`
 * are plain regexes over raw source (see LIMITATIONS above), so a call-shaped
 * fragment inside a comment (`// cameraCallbacks.resolveHighlightIds(ids)`)
 * or a string literal (`"resolveHighlightIds(ids)"`) previously satisfied
 * them exactly as well as a real call -- meaning a routing call commented
 * out mid-refactor, or quoted in a log message, read as "still routed". This
 * gate's whole premise is that a false negative here is the failure mode it
 * exists to close (see the file header), so this is intentionally NOT a
 * full lexer/parser -- it is a single left-to-right scan with three states
 * (line comment, block comment, string), and it is honest about what that
 * naive scan does not handle:
 *   - A regex literal containing a quote or `//`/`/*` sequence (e.g.
 *     `/["/]/`) is not distinguished from a string or comment start -- its
 *     quote or slash characters can desync the scan for the rest of the
 *     file. Not observed in the scanned tree.
 *   - Escaped-quote handling is a single backslash lookback (`\"` inside a
 *     string skips the quote), not a parity count -- a string ending in an
 *     even run of backslashes before its closing quote (`"a\\\\"`, a literal
 *     backslash followed by a real close) is handled correctly, but this was
 *     verified by construction, not by tracking backslash-run parity, so an
 *     unusual escape sequence could still mislead it.
 *   - A `${...}` interpolation inside a template literal is stripped along
 *     with the rest of the backtick span -- a call that legitimately lives
 *     inside an interpolation (`` `${resolveHighlightIds(ids)}` ``) is
 *     treated the same as a call inside dead text and will not be seen as a
 *     routing call. Not observed in the scanned tree; a channel routing
 *     ONLY this way would need a comment-visible, non-interpolated call
 *     elsewhere, or a NO_MARKER_REQUIRED entry.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripCommentsAndStrings(content) {
  let out = '';
  const n = content.length;
  let i = 0;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < n && content[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(content[j] === '*' && content[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      for (let k = i; k < j; k++) out += content[k] === '\n' ? '\n' : ' ';
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n && content[j] !== quote) {
        j += content[j] === '\\' && j + 1 < n ? 2 : 1;
      }
      j = Math.min(j + 1, n);
      for (let k = i; k < j; k++) out += content[k] === '\n' ? '\n' : ' ';
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
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
  const code = stripCommentsAndStrings(content);
  if (
    !CALL_PATTERN.test(code) &&
    !SET_ISOLATED_CALL_PATTERN.test(code) &&
    !ALIAS_DESTRUCTURE_PATTERN.test(code) &&
    !PROPERTY_ALIAS_PATTERN.test(code)
  ) {
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
    if (ROUTING_MARKERS.test(code)) {
      return { isCandidate: true, ok: true };
    }
    return {
      isCandidate: true,
      ok: false,
      reason:
        'calls a raw isolation action (isolateEntities( / setIsolatedEntities() but no ' +
        'resolveHighlightIds / expandToGeometryBearingIds / expandFilterRowsThroughAggregation ' +
        'call was found in the file -- this known channel appears to have lost its ' +
        'assembly-expansion routing.',
    };
  }
  return {
    isCandidate: true,
    ok: false,
    reason:
      'calls a raw isolation action (isolateEntities( / setIsolatedEntities() -- or binds one via ' +
      'destructuring) and is not in either allowlist (REQUIRES_ROUTING_MARKER / ' +
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

  const seenRoutedCount = [...seenAllowlisted].filter((path) => REQUIRES_ROUTING_MARKER.has(path)).length;
  const seenExemptCount = [...seenAllowlisted].filter((path) => NO_MARKER_REQUIRED.has(path)).length;

  console.log(
    `check-isolate-expansion-routing: OK (${files.length} file(s) scanned, ${candidateCount} candidate ` +
    `channel file(s) calling a raw isolation action -- ${seenAllowlisted.size} allowlisted: ` +
    `${seenRoutedCount} routed, ${seenExemptCount} exempt-with-reason)`,
  );
}

if (isMainEntry(import.meta.url)) {
  main();
}
