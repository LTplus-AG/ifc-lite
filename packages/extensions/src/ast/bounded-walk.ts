/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Depth-bounded, non-recursive AST traversal.
 *
 * Every AST walked in this package comes from source an extension
 * author supplies, so the traversal is attacker-reachable and must not
 * be able to exhaust the JS call stack. `acorn-walk`'s walkers recurse
 * once per AST level; a script nested a few hundred levels deep throws
 * `RangeError: Maximum call stack size exceeded` out of the middle of
 * whatever function invoked the walk.
 *
 * This module is the single traversal used by every AST consumer here
 * — `validateCode`, `inferCapabilities` and the entry-script
 * banned-construct scan in `host/source-wrap.ts`. It keeps its own
 * stack on the heap and stops at {@link MAX_AST_DEPTH}, *reporting*
 * that it stopped rather than throwing. Callers vary the visitor; they
 * do not re-implement the traversal, and there is exactly one depth
 * bound for them to disagree about.
 *
 * It descends using `acorn-walk`'s own `base` visitor rather than
 * enumerating object properties generically, so which child positions
 * count as nodes is identical to what `walk.simple` would have visited:
 * non-computed member properties, non-computed object keys and labels
 * stay unvisited. Nodes are reported in `walk.simple`'s post-order
 * (children before parent) for the same reason — swapping either would
 * silently change what the call sites see.
 *
 * Deliberately NOT exported from the package entry point — internal
 * utility, not public API.
 */

import * as walk from 'acorn-walk';

/**
 * Maximum AST nesting depth any walk in this package will inspect.
 *
 * Real scripts nest a few tens of levels deep; this bound is two orders
 * of magnitude above that. It exists because the AST comes from
 * author-controlled source: past this depth the walk stops and the
 * caller reports a validation failure instead of continuing.
 *
 * One `if (1) { … }` source level costs two levels here
 * (`IfStatement` -> `BlockStatement`), so the bound bites at 500 such
 * source levels.
 *
 * The bound is in AST levels, so its effective *source*-level threshold
 * varies by construct, and for cheap constructs it is unreachable. An
 * arrow link (`() => () => …`) costs one level, not two, so this bound
 * would need ~1000 of them — and acorn runs out of stack parsing that
 * shape at a few hundred links, well before the walk is ever asked. The
 * asymmetry is intended: the bound guards the walk's own stack, and a
 * construct that the parser rejects first never reaches the walk.
 * `host/source-wrap.test.ts` pins both the 1:2 cost ratio and the fact
 * that every parseable arrow depth is accepted.
 *
 * Do NOT think of this as "well under acorn's own parser limit": acorn
 * has no fixed limit to be under. The same script, on Node 22, parses
 * at 1100 source levels and aborts the process at 1200 in a
 * default-stack run, is rejected at 1200 under this repo's vitest
 * workers ("Not enough stack space to parse input"), and parses at
 * 4000 under `node --stack-size=4000`. The parser's give-up point is a
 * property of the host's remaining stack, not of acorn — and one of
 * those three failures is a fatal V8 abort (exit 134), not a catchable
 * error. This bound does not move, which is the entire point: the
 * accept/reject boundary must not depend on the caller's remaining
 * stack.
 *
 * Catching the `RangeError` instead would reintroduce exactly that
 * dependency. Measured on this repo's suite before the fix, an
 * unbounded walk over a 600-level script overflowed while a 700-level
 * one did not, and which of the two overflowed moved with test order.
 */
export const MAX_AST_DEPTH = 1000;

/** Minimal structural view of an ESTree node. */
export interface AstNode {
  type: string;
  [key: string]: unknown;
}

export interface BoundedWalkResult {
  /**
   * True if traversal stopped early because a node deeper than
   * {@link MAX_AST_DEPTH} was reached. When true the visit is
   * incomplete and the caller MUST treat the result as a failure —
   * never as "nothing found".
   */
  depthExceeded: boolean;
  /**
   * Node types `acorn-walk` had no `base` entry for, deduplicated. The
   * subtree under such a node was NOT descended, so — exactly like
   * {@link depthExceeded} — the visit is incomplete and the caller MUST
   * treat a non-empty list as a failure. Every call site here is a
   * scanner looking for things it must not find, so an unwalkable
   * subtree is a scan that found nothing because it never looked.
   *
   * This is how a walk sees an acorn upgrade that lands a new node type
   * ahead of `acorn-walk` (class static blocks, import attributes and
   * `await using` all arrived that way). `acorn-walk` throws on a
   * missing base for the same reason; we report instead of throwing
   * because the callers are declared to return a result, not to throw.
   */
  unwalkableTypes: readonly string[];
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

interface Frame {
  node: AstNode;
  depth: number;
  /**
   * `acorn-walk` re-dispatches some nodes under a synthetic type
   * ("Statement", "Expression", "Function", "Pattern", …). The visitor
   * key is `override || node.type`, exactly as in `walk.simple`.
   */
  override?: string;
  /** False on the descend pass, true on the report pass. */
  expanded: boolean;
}

/**
 * Visit every node `walk.simple` would have visited, in the same order,
 * without recursing and without exceeding {@link MAX_AST_DEPTH}.
 *
 * The visitor is handed the raw node plus the type key `walk.simple`
 * would have looked its visitor up under; call sites switch on that
 * key. One traversal is therefore shared across sites that care about
 * entirely different node types.
 *
 * Returns `depthExceeded: true` if the bound stopped the walk, and
 * lists in `unwalkableTypes` any node type it could not descend. The
 * traversal never throws for either reason — but a caller that ignores
 * either field is reporting "clean" on a tree it did not finish
 * reading.
 */
export function walkBounded(
  root: unknown,
  visit: (node: AstNode, type: string) => void,
): BoundedWalkResult {
  if (!isAstNode(root)) return { depthExceeded: false, unwalkableTypes: [] };

  const baseVisitor = walk.base as unknown as Record<
    string,
    ((node: unknown, state: unknown, c: (child: unknown, state: unknown, override?: string) => void) => void) | undefined
  >;

  const stack: Frame[] = [{ node: root, depth: 0, expanded: false }];
  const unwalkable = new Set<string>();

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const type = frame.override ?? frame.node.type;

    if (frame.expanded) {
      visit(frame.node, type);
      continue;
    }

    if (frame.depth > MAX_AST_DEPTH) {
      return { depthExceeded: true, unwalkableTypes: [...unwalkable] };
    }

    const baseFn = baseVisitor[type];
    if (!baseFn) {
      // No base for this type: we cannot enumerate its children, so its
      // whole subtree goes uninspected. Report the node itself and keep
      // walking its siblings — the rest of the tree is still worth
      // scanning — but record the type so the caller fails instead of
      // reading the visitor's silence as "nothing found".
      unwalkable.add(type);
      visit(frame.node, type);
      continue;
    }

    const children: Frame[] = [];
    baseFn(frame.node, null, (child, _state, override) => {
      if (!isAstNode(child)) return;
      children.push({
        node: child,
        // `skipThrough` bases re-dispatch the *same* node under a new
        // key; that is not a step down the tree, so it must not consume
        // a depth level.
        depth: child === frame.node ? frame.depth : frame.depth + 1,
        override,
        expanded: false,
      });
    });

    // Report-after-children, matching walk.simple's post-order: push
    // the report frame first so it pops last, then the children in
    // reverse so the LIFO stack takes them in source order.
    stack.push({ ...frame, expanded: true });
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]!);
    }
  }

  return { depthExceeded: false, unwalkableTypes: [...unwalkable] };
}
