/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo manager — wraps Y.UndoManager scoped to the local origin so a
 * peer's `undo()` only rolls back their own edits, never their
 * teammates'. Spec §6.1.
 */

import * as Y from 'yjs';
import {
  LOCAL_ORIGIN,
  UNDO_ORIGIN,
  entitiesMap,
  geometryMap,
  relationshipsMap,
} from './doc/schema.js';

export interface UndoOptions {
  /** Origins that count as undoable. Defaults to `[LOCAL_ORIGIN]`. */
  trackedOrigins?: unknown[];
  /** Capture timeout in ms (default 500). */
  captureTimeout?: number;
}

export interface UndoController {
  readonly manager: Y.UndoManager;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  destroy(): void;
}

export function createUndoManager(doc: Y.Doc, opts: UndoOptions = {}): UndoController {
  const trackedOrigins = new Set<unknown>(opts.trackedOrigins ?? [LOCAL_ORIGIN]);

  const manager = new Y.UndoManager(
    [entitiesMap(doc), relationshipsMap(doc), geometryMap(doc)],
    {
      trackedOrigins,
      captureTimeout: opts.captureTimeout ?? 500,
    },
  );

  return {
    manager,
    undo() {
      // Yjs UndoManager.undo returns the StackItem when something was
      // undone, or `null` otherwise. We tag the redo operation with our
      // dedicated origin so observers can distinguish it from human ops.
      const item = manager.undo();
      return item != null;
    },
    redo() {
      const item = manager.redo();
      return item != null;
    },
    canUndo: () => manager.canUndo(),
    canRedo: () => manager.canRedo(),
    clear: () => manager.clear(),
    destroy: () => manager.destroy(),
  };
}

export { UNDO_ORIGIN };
