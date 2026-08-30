/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Static capability inference for promoted scripts.
 *
 * Walks the AST of a saved script and reports the minimum capability set
 * the script requires at runtime. Used by the "Promote to tool" UX
 * (Phase 1) to pre-fill the capability grant on the review screen.
 *
 * Design rules:
 *   1. **Over-grant on uncertainty.** If we cannot determine the exact
 *      capability, return a broader one. The user reviews and narrows.
 *   2. **Never under-grant.** If the inferred set is wrong, prefer
 *      "extension breaks at install" over "extension silently uses an
 *      unauthorised capability."
 *   3. **Surface unknowns.** Calls into unknown namespaces produce a
 *      warning in the result so reviewers can investigate. So do calls
 *      whose method the catalogue never classified inside a namespace
 *      that otherwise differentiates capability by method — see
 *      `isRecognisedMethod` in `./catalogue.ts` for exactly which calls
 *      that covers.
 *   4. **No execution.** This is pure static analysis. We do not run the
 *      script during inference.
 *
 * Spec: docs/architecture/ai-customization/09-implementation-plan.md
 * task P1.T10.
 */

import * as acorn from 'acorn';
import { MAX_AST_DEPTH, walkBounded } from '../ast/bounded-walk.js';
import { lookupNamespaceMethod, isRecognisedMethod } from './catalogue.js';

export interface InferenceResult {
  /** De-duplicated capability strings, sorted. */
  capabilities: string[];
  /** Per-call observations. Useful for the review UI and AI repair. */
  observations: InferenceObservation[];
  /** Parse errors. If present, capabilities are best-effort partial. */
  parseErrors: InferenceParseError[];
}

export interface InferenceObservation {
  /** "bim.viewer.flyTo" — the full dotted reference. */
  call: string;
  /** Inferred capabilities for this call. */
  capabilities: string[];
  /**
   * True if the catalogue does not actually classify this call: either
   * the namespace itself is unrecognised, or the namespace differentiates
   * capability by method and this specific method has no entry. The two
   * cases differ in what `capabilities` holds: an unclassified method in
   * a known namespace still gets that namespace's default (an
   * over-grant), while an unknown namespace has no default to fall back
   * on and yields an empty list. See `isRecognisedMethod` in
   * `./catalogue.ts`.
   */
  unknown: boolean;
}

export interface InferenceParseError {
  message: string;
  line: number;
  column: number;
}

/**
 * Infer the capability set required by a script.
 *
 * The input must be ES module-shaped JavaScript or TypeScript that has
 * already been type-stripped (the host's sandbox transpiler runs first
 * in the promote flow). Passing TypeScript with annotations may produce
 * parse errors; callers should strip types first or accept the partial
 * result.
 */
export function inferCapabilities(source: string): InferenceResult {
  if (typeof source !== 'string') {
    return {
      capabilities: [],
      observations: [],
      parseErrors: [{ message: 'source must be a string', line: 0, column: 0 }],
    };
  }
  if (source.trim().length === 0) {
    return { capabilities: [], observations: [], parseErrors: [] };
  }

  let ast: acorn.Node;
  const parseErrors: InferenceParseError[] = [];
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (err) {
    // Acorn errors carry `loc` info; capture and bail out.
    const e = err as Error & { loc?: { line: number; column: number } };
    parseErrors.push({
      message: e.message,
      line: e.loc?.line ?? 0,
      column: e.loc?.column ?? 0,
    });
    return { capabilities: [], observations: [], parseErrors };
  }

  const observations: InferenceObservation[] = [];
  const { depthExceeded, unwalkableTypes } = walkBounded(ast, (node, type) => {
    if (type !== 'MemberExpression') return;
    const chain = readMemberChain(node);
    if (!chain || chain[0] !== 'bim') return;
    // Patterns we care about:
    //   bim.<ns>             — at least 2 parts. Untargeted; default ns.
    //   bim.<ns>.<method>    — 3 parts; specific method.
    //   bim.<ns>.<method>(...) — same; we record at the chain stage.
    const namespace = chain[1] ?? undefined;
    const method = chain[2] ?? undefined;
    if (!namespace) return;
    const call = `bim.${namespace}${method ? `.${method}` : ''}`;
    const caps = method
      ? lookupNamespaceMethod(namespace, method)
      : INFERENCE_FALLBACK_FOR(namespace);
    observations.push({
      call,
      capabilities: [...caps],
      unknown: !isRecognisedMethod(namespace, method),
    });
  });

  // A walk that stopped at the depth bound has NOT seen the whole
  // script, so the capability set it produced is a floor, not the
  // answer. Returning it as-is would fail open in both directions:
  // `migrateSavedScripts` treats an empty set as "grant model.read and
  // migrate anyway", and the promote dialog renders "No `bim.*` calls
  // detected". Report it through `parseErrors`, which is the channel
  // both callers already use to refuse the script — the migration skips
  // it, and the dialog shows the warning.
  if (depthExceeded) {
    parseErrors.push({
      message: `source is nested more than ${MAX_AST_DEPTH} AST levels deep; capabilities could not be inferred`,
      line: 0,
      column: 0,
    });
    return { capabilities: [], observations: [], parseErrors };
  }

  // A subtree the walker could not descend hides `bim.*` calls just as
  // effectively as the depth bound does, so it goes down the same
  // channel and the inferred set is discarded rather than published as
  // if it were complete.
  if (unwalkableTypes.length > 0) {
    parseErrors.push({
      message: `source contains AST node types the walker cannot traverse (${unwalkableTypes.join(', ')}); capabilities could not be inferred`,
      line: 0,
      column: 0,
    });
    return { capabilities: [], observations: [], parseErrors };
  }

  return {
    capabilities: dedupeAndSort(observations.flatMap((o) => o.capabilities)),
    observations: dedupeObservations(observations),
    parseErrors,
  };
}

/** When the call site is `bim.<ns>` with no method, use the namespace default. */
function INFERENCE_FALLBACK_FOR(namespace: string): readonly string[] {
  return lookupNamespaceMethod(namespace, '__default__');
}

interface MemberLike {
  type: string;
  object?: MemberLike;
  property?: { type: string; name?: string };
  name?: string;
  computed?: boolean;
}

/**
 * Read a static member chain like `bim.viewer.flyTo` into ['bim','viewer','flyTo'].
 * Returns undefined if the chain contains computed access or non-identifier
 * pieces (we do not chase those — would over-grant by guessing).
 */
function readMemberChain(node: unknown): string[] | undefined {
  const parts: string[] = [];
  let cur: MemberLike | undefined = node as MemberLike;
  while (cur && cur.type === 'MemberExpression') {
    if (cur.computed) return undefined;
    const prop = cur.property;
    if (!prop || prop.type !== 'Identifier' || !prop.name) return undefined;
    parts.unshift(prop.name);
    cur = cur.object;
  }
  if (!cur || cur.type !== 'Identifier' || !cur.name) return undefined;
  parts.unshift(cur.name);
  return parts;
}

function dedupeAndSort(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function dedupeObservations(obs: readonly InferenceObservation[]): InferenceObservation[] {
  const seen = new Map<string, InferenceObservation>();
  for (const o of obs) {
    if (!seen.has(o.call)) seen.set(o.call, o);
  }
  return Array.from(seen.values()).sort((a, b) => a.call.localeCompare(b.call));
}
