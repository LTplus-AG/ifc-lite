/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Which call sites actuate a presentation channel without routing through the
 * assembly-expansion resolver?" -- the analysis half of
 * `scripts/check-isolate-expansion-routing.mjs` (#3338).
 *
 * Separated from the gate so the question can be asked, and tested, without a
 * filesystem walk or an allowlist: give it source text with comments and
 * strings already stripped, get back the offending call sites. The gate keeps
 * the parts that need the repo -- walking the tree, consulting the allowlists,
 * printing failures, choosing an exit code.
 */

import { POLICED_ACTIONS } from './presentation-channel-allowlist.mjs';

/** The resolvers that actually perform `IfcRelAggregates` expansion, or read
 *  from a resolver that does, called as real code (not merely named in prose).
 *  `resolvePresentationIds` (`apps/viewer/src/lib/presentation/resolvePresentationIds.ts`,
 *  #3338) is the shared policy wrapper most isolation channels now
 *  call INSTEAD of `resolveHighlightIds` directly -- it takes the resolver
 *  as its first argument rather than invoking it inline, so a channel that
 *  switched to it no longer contains the literal `resolveHighlightIds(`
 *  call this pattern used to require. (`PropertiesPanel.tsx` and
 *  `SearchModal.filter.tsx` still call the resolver inline on purpose, each
 *  with its own reason in the source -- both spellings must keep passing.) */
export const ROUTING_MARKERS =
  /\b(resolveHighlightIds|expandToGeometryBearingIds|expandFilterRowsThroughAggregation|resolvePresentationIds|resolvePresentationColorMap)\b\s*\?{0,1}\.{0,1}\s*\(/;

/** A call to one policed action: `name(`, `state.name(`, or `...name?.(`. */
export function actionCallPattern(name) {
  return new RegExp(`\\b${name}\\s*\\?{0,1}\\.{0,1}\\s*\\(`, 'g');
}

/**
 * The text of the argument list starting at `open` (the index of the `(`),
 * or null if the parens never balance. Bracket-aware only for `()`, which is
 * enough: the input has already been through `stripCommentsAndStrings`, so no
 * stray paren can hide inside a comment or a string.
 */
function argumentTextAt(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return null;
}

/** Identifiers appearing in an argument list, minus the obvious non-locals. */
const ARG_IDENT_SKIP = new Set(['new', 'Set', 'Map', 'Array', 'from', 'of', 'null', 'undefined', 'true', 'false', 'state', 's', 'get', 'store']);

/**
 * Does `ident` get assigned, anywhere in `code`, from an expression that
 * contains a `ROUTING_MARKERS` call?
 *
 * This is the one level of data flow the gate needs and the only one it does:
 * every routed channel today either wraps the resolver inline in the action's
 * own argument (`setIsolatedEntities(new Set(resolvePresentationIds(...)))`)
 * or computes it into a local first (`const isolationIds =
 * resolvePresentationIds(...); isolateEntities(isolationIds);`). Anything
 * deeper -- a local assigned from another local, a value round-tripped
 * through a helper in the same file -- reads as UNROUTED here. That is the
 * safe direction to be wrong in: it costs a false failure a reviewer can
 * resolve with an allowlist entry, not a false pass.
 */
function assignedFromRoutingMarker(code, ident, seen = new Set(), depth = 0) {
  if (depth > ASSIGNMENT_WALK_DEPTH || seen.has(ident)) return false;
  seen.add(ident);
  const assign = new RegExp(`\\b${ident}\\s*=(?!=)`, 'g');
  let m;
  while ((m = assign.exec(code)) !== null) {
    const start = m.index + m[0].length;
    let nesting = 0;
    let end = start;
    while (end < code.length) {
      const ch = code[end];
      if (ch === '(' || ch === '[' || ch === '{') nesting += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (nesting === 0) break;
        nesting -= 1;
      } else if (ch === ';' && nesting === 0) break;
      end += 1;
    }
    const rhs = code.slice(start, end);
    if (ROUTING_MARKERS.test(rhs)) return true;
    const next = [...new Set(rhs.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter(
      (id) => !ARG_IDENT_SKIP.has(id) && !seen.has(id),
    );
    if (next.some((id) => assignedFromRoutingMarker(code, id, seen, depth + 1))) return true;
  }
  return false;
}

/** How many local-assignment hops the walk above follows. One hop covers the
 *  common `const ids = resolvePresentationIds(...)` shape; SearchModal.filter
 *  needs two (`const resolved = cameraCallbacks.resolveHighlightIds?.(...)`,
 *  then `const isolationIds = [...resolved, ...]`). Bounded rather than
 *  unlimited so a long chain of unrelated locals in a big file cannot wander
 *  into an unrelated marker call and manufacture a false pass. */
const ASSIGNMENT_WALK_DEPTH = 3;

/** Arguments with nothing to expand: releasing a channel rather than
 *  installing ids into it. `setIsolatedEntities(null)` clears the isolation,
 *  `showEntities([])` is a no-op -- neither names an entity, so neither can
 *  name a geometry-less assembly. Structural, not an exemption: there is no
 *  judgement call to record. */
const NOTHING_TO_EXPAND = /^\s*(null|undefined|\[\s*\]|new\s+Set\s*\(\s*\)|new\s+Map\s*\(\s*\))\s*$/;

/**
 * Every policed call site in `code` that does NOT reach a routing marker.
 *
 * #3338 review: `ROUTING_MARKERS.test(code)` asked the question PER FILE, so
 * once a file carried any routing call anywhere, stripping the routing from
 * one of its call sites left the file reading as ok. `visibility-adapter.ts`
 * and `handler.ts` each route four channels in one file, which is exactly the
 * shape that made the file-level question vacuous: deleting the isolate()
 * routing there kept the gate green because hide() still routed.
 *
 * @param {string} code source with comments and strings already stripped
 * @returns {Array<{ action: string, kind: string, arg: string }>}
 */
export function unroutedCallSites(code) {
  const out = [];
  for (const { name, kind } of POLICED_ACTIONS) {
    const pattern = actionCallPattern(name);
    let m;
    while ((m = pattern.exec(code)) !== null) {
      const open = code.indexOf('(', m.index + name.length);
      const arg = open === -1 ? null : argumentTextAt(code, open);
      if (arg === null) {
        out.push({ action: name, kind, arg: '<unbalanced parentheses>' });
        continue;
      }
      if (ROUTING_MARKERS.test(arg) || NOTHING_TO_EXPAND.test(arg)) continue;
      const idents = [...new Set(arg.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter(
        (id) => !ARG_IDENT_SKIP.has(id),
      );
      if (idents.some((id) => assignedFromRoutingMarker(code, id))) continue;
      out.push({ action: name, kind, arg: arg.trim().slice(0, 80) });
    }
  }
  return out;
}
