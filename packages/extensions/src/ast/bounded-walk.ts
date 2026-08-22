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
 * It keeps its own stack on the heap and stops at {@link MAX_AST_DEPTH},
 * *reporting* that it stopped rather than throwing. Callers vary the
 * visitor; they do not re-implement the traversal.
 *
 * Two of the package's three author-source walks go through here:
 * `validate/code.ts` and `inference/capability.ts`. The third,
 * `host/source-wrap.ts`'s `checkBannedConstructs`, keeps its own
 * heap-stack traversal — it enumerates child properties generically
 * instead of descending through `acorn-walk`'s `base`, so it visits a
 * superset of these positions. It does not keep its own limit: it
 * imports {@link MAX_AST_DEPTH} from here, so raising or lowering the
 * bound moves both walks rather than opening a band where one gate on
 * author-supplied source accepts what the next refuses. (The two count
 * a level slightly differently — generic property nesting versus
 * `base`'s child dispatch — so they are not guaranteed to cut the same
 * script at the same node, only to share the same budget.)
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
 * (`IfStatement` -> `BlockStatement`), and acorn's own parser gives up
 * at roughly 1200 *source* levels ("Not enough stack space to parse
 * input"). That parser limit moves with however much stack the host
 * happens to have left; this one does not, which is the entire point —
 * the accept/reject boundary must not depend on the caller's remaining
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
 * Returns `{ depthExceeded: true }` if the bound stopped the walk. The
 * traversal never throws for depth reasons.
 */
export function walkBounded(
  root: unknown,
  visit: (node: AstNode, type: string) => void,
): BoundedWalkResult {
  if (!isAstNode(root)) return { depthExceeded: false };

  const baseVisitor = walk.base as unknown as Record<
    string,
    ((node: unknown, state: unknown, c: (child: unknown, state: unknown, override?: string) => void) => void) | undefined
  >;

  const stack: Frame[] = [{ node: root, depth: 0, expanded: false }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const type = frame.override ?? frame.node.type;

    if (frame.expanded) {
      visit(frame.node, type);
      continue;
    }

    if (frame.depth > MAX_AST_DEPTH) return { depthExceeded: true };

    const baseFn = baseVisitor[type];
    if (!baseFn) {
      // Unknown node type: report it and stop descending, matching
      // acorn-walk's own behaviour of throwing only on a missing base.
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

  return { depthExceeded: false };
}
