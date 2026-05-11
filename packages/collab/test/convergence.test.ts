/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two-peer convergence: edits made on either Y.Doc and replayed via
 * `applyUpdate` end up with identical state on both peers — the basic
 * CRDT contract that the rest of the package relies on.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, getAttribute, setAttribute } from '../src/doc/entity.js';
import { createConflictDetector } from '../src/conflicts/detector.js';

function syncOnce(a: Y.Doc, b: Y.Doc) {
  const aSv = Y.encodeStateVector(a);
  const bSv = Y.encodeStateVector(b);
  const aToB = Y.encodeStateAsUpdate(a, bSv);
  const bToA = Y.encodeStateAsUpdate(b, aSv);
  Y.applyUpdate(b, aToB);
  Y.applyUpdate(a, bToA);
}

describe('two-peer convergence', () => {
  it('non-conflicting edits to different attributes converge', () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    a.transact(() => createEntity(a, 'w'));
    syncOnce(a, b);
    a.transact(() => setAttribute(a, 'w', 'Name', 'WallA'));
    b.transact(() => setAttribute(b, 'w', 'Description', 'desc-from-B'));
    syncOnce(a, b);

    expect(getAttribute(a, 'w', 'Name')).toBe('WallA');
    expect(getAttribute(b, 'w', 'Name')).toBe('WallA');
    expect(getAttribute(a, 'w', 'Description')).toBe('desc-from-B');
    expect(getAttribute(b, 'w', 'Description')).toBe('desc-from-B');
  });

  it('conflicting edits resolve LWW and detector fires', async () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    a.transact(() => createEntity(a, 'w'));
    syncOnce(a, b);

    const aDetector = createConflictDetector(a, { windowMs: 5000 });
    const bDetector = createConflictDetector(b, { windowMs: 5000 });
    const aEvents: string[] = [];
    const bEvents: string[] = [];
    aDetector.onConflict((e) => aEvents.push(`${e.kind}|${e.path}|${e.field}`));
    bDetector.onConflict((e) => bEvents.push(`${e.kind}|${e.path}|${e.field}`));

    a.transact(() => setAttribute(a, 'w', 'Name', 'A-version'));
    b.transact(() => setAttribute(b, 'w', 'Name', 'B-version'));
    syncOnce(a, b);

    // Both peers converge on the same value (LWW; the actual winner is
    // deterministic per Yjs but we don't care which one).
    expect(getAttribute(a, 'w', 'Name')).toBe(getAttribute(b, 'w', 'Name'));

    // Both peers' detectors should have at least one matching event.
    expect(aEvents.some((e) => e.startsWith('attribute|w|Name'))).toBe(true);
    expect(bEvents.some((e) => e.startsWith('attribute|w|Name'))).toBe(true);

    aDetector.destroy();
    bDetector.destroy();
  });
});
