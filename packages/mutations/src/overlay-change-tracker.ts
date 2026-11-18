// SPDX-License-Identifier: MPL-2.0
import type { MutablePropertyView } from './mutable-property-view.js';
import { cooperativeOverlay } from './cooperative-overlay-access.js';

type Listener = (id: number | null) => void;
const listeners = new WeakMap<object, Set<Listener>>();
const origins = new WeakMap<MutablePropertyView, { view: MutablePropertyView; revision: number }>();

/** @internal Notify only invalidation; subscribers must read after the write. */
export function overlayChanged(view: object, id: number | null = null): void {
  const bucket = listeners.get(view);
  if (bucket) for (const listener of bucket) listener(id);
}
/** @internal Detached drafts may borrow a matching parent's read inventory. */
export function registerOverlayOrigin(draft: MutablePropertyView, view: MutablePropertyView): void {
  origins.set(draft, { view, revision: view.getMutationRevision() });
}

/** A bounded, disposable invalidation cursor, independent of undo history. */
export interface EntityChangeTracker {
  readonly origin: Readonly<{ view: MutablePropertyView; revision: number }> | undefined;
  /** null means a full restoration, or more than 65,536 distinct changes. */
  take(): ReadonlySet<number> | null;
  dispose(): void;
}

/** Track effective edits, including skip-history writes and atomic publication.
 * Escaped mutable creation arrays are conservatively dirty on every read.
 * The cursor retains IDs only, and must be disposed when no longer needed. */
export function trackEntityChanges(view: MutablePropertyView): EntityChangeTracker {
  let dirty: Set<number> | null = new Set();
  const listener: Listener = id => {
    if (id === null) dirty = null;
    else if (dirty) { dirty.add(id); if (dirty.size > 65_536) dirty = null; }
  };
  let bucket = listeners.get(view);
  if (!bucket) listeners.set(view, bucket = new Set());
  bucket.add(listener);
  return {
    origin: origins.get(view),
    take() {
      // The map may have changed after a full restoration. Its exposure list
      // includes existing aliases and is not cleared when an alias is read.
      cooperativeOverlay(view).capture().newEntities.watchAttributeExposure(listener)();
      const result = dirty;
      dirty = new Set();
      return result;
    },
    dispose() { bucket.delete(listener); },
  };
}
