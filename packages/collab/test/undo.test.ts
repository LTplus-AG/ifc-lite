/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc, LOCAL_ORIGIN } from '../src/doc/schema.js';
import { createEntity, getAttribute, setAttribute } from '../src/doc/entity.js';
import { createUndoManager } from '../src/undo.js';

describe('undo manager', () => {
  it('rolls back local-origin attribute writes', () => {
    const doc = createCollabDoc();
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    createEntity(doc, 'wall');

    doc.transact(() => setAttribute(doc, 'wall', 'Name', 'A'), LOCAL_ORIGIN);
    doc.transact(() => setAttribute(doc, 'wall', 'Name', 'B'), LOCAL_ORIGIN);
    expect(getAttribute(doc, 'wall', 'Name')).toBe('B');

    expect(undo.canUndo()).toBe(true);
    undo.undo();
    expect(getAttribute(doc, 'wall', 'Name')).toBe('A');
    undo.undo();
    expect(getAttribute(doc, 'wall', 'Name')).toBeUndefined();

    expect(undo.canRedo()).toBe(true);
    undo.redo();
    expect(getAttribute(doc, 'wall', 'Name')).toBe('A');
  });

  it('does not roll back non-local origins', () => {
    const doc = createCollabDoc();
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    createEntity(doc, 'wall');

    // Untracked origin: should NOT be undoable.
    doc.transact(() => setAttribute(doc, 'wall', 'Name', 'remote'), 'remote-peer');
    expect(undo.canUndo()).toBe(false);
    expect(getAttribute(doc, 'wall', 'Name')).toBe('remote');
  });
});
