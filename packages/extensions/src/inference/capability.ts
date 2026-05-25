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
 *      warning in the result so reviewers can investigate.
 *   4. **No execution.** This is pure static analysis. We do not run the
 *      script during inference.
 *
 * Spec: docs/architecture/ai-customization/09-implementation-plan.md
 * task P1.T10.
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { lookupNamespaceMethod, isKnownNamespace } from './catalogue.js';

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
  /** True if we know nothing about this call (catalogue miss). */
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
  walk.simple(ast as acorn.AnyNode, {
    MemberExpression(node) {
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
        unknown: !isKnownNamespace(namespace),
      });
    },
  });

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
