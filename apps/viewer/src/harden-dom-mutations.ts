/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Harden `Node.prototype.removeChild` / `insertBefore` against external DOM
 * mutation so the React reconciler can't crash the whole app.
 *
 * When a browser translation extension (Google Translate, the built-in
 * Edge/Chrome translator, …), a password manager, or any other agent rewrites
 * the DOM React owns, React's commit phase later tries to remove or move a node
 * relative to a parent that no longer holds it. The native call then throws an
 * UNCAUGHT `DOMException`:
 *
 *   NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be
 *   removed is not a child of this node.
 *   NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before
 *   which the new node is to be inserted is not a child of this node.
 *
 * Because the throw happens deep inside the reconciler (no app frame on the
 * stack — see PostHog issues #1229/#1230 removeChild, #1232 insertBefore, all
 * minified React-internal frames), it tears down the React tree and surfaces as
 * a hard crash to the user. It is not a bug in our components; we can't stop the
 * extension from editing the DOM, but we can make these two operations no-ops
 * when the node/parent relationship has already been broken, which is exactly
 * what the React team recommends (facebook/react#11538). React then proceeds as
 * if the (already-detached) work succeeded.
 *
 * Imported for its side effect from main.tsx BEFORE react-dom initializes, so
 * the reconciler only ever sees the guarded methods. Runs in dev and prod —
 * the crash is observed in production.
 */

if (typeof Node !== 'undefined' && Node.prototype) {
  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      // An external agent already detached/moved `child`; React thinks it still
      // lives here. Pretend the removal happened instead of throwing.
      if (import.meta.env.DEV && typeof console !== 'undefined') {
        console.warn('[harden-dom] suppressed removeChild on a node with a different parent', child);
      }
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function insertBefore<T extends Node>(
    this: Node,
    node: T,
    child: Node | null,
  ): T {
    if (child && child.parentNode !== this) {
      // The reference node was re-parented out from under us; inserting before
      // it would throw. Fall back to a plain append so React's insert still
      // lands in the parent it expects.
      if (import.meta.env.DEV && typeof console !== 'undefined') {
        console.warn('[harden-dom] suppressed insertBefore with a reference node from a different parent', child);
      }
      return originalInsertBefore.call(this, node, null) as T;
    }
    return originalInsertBefore.call(this, node, child) as T;
  };
}
