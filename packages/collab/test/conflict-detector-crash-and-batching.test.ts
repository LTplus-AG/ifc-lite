/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for issue #5215:
 *
 *  1. `createConflictDetector` must never throw out of a doc's
 *     `afterTransaction` handler, even when a top-level shared map
 *     decodes as a bare `Y.AbstractType` (see `writersForKey`'s
 *     docblock in `detector.ts` for why that happens: `Y.Doc#get`
 *     defaults to `AbstractType`, and only `Y.Doc#getMap` specializes
 *     it — a raw `new Y.Doc()` handed in via `CollabSessionOptions.doc`
 *     and touched by a remote update before any local `entitiesMap()`
 *     call hits this on its very first `afterTransaction`).
 *  2. One `Y.applyUpdate` that batches structs from two different
 *     remote clients must detect the same conflict as the same edit
 *     delivered as two separate transactions.
 *
 * Real `yjs`, real `detector.ts` — no mocks.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, setAttribute } from '../src/doc/entity.js';
import { createConflictDetector, type ConflictEvent } from '../src/conflicts/detector.js';

describe('#5215 finding 2: bare AbstractType top-level parent must not crash', () => {
  it('concurrent entity creation at the same path, applied to an un-warmed doc, does not throw', () => {
    const peerA = createCollabDoc();
    createEntity(peerA, 'E1', { ifcClass: 'IfcWall' });
    const updA = Y.encodeStateAsUpdate(peerA);

    const peerB = createCollabDoc();
    createEntity(peerB, 'E1', { ifcClass: 'IfcWall' });
    const updB = Y.encodeStateAsUpdate(peerB);

    // A raw, never-locally-touched doc — exactly what session.ts wires
    // the detector onto when CollabSessionOptions.doc is supplied by a
    // caller instead of going through createCollabDoc().
    const raw = new Y.Doc();
    const detector = createConflictDetector(raw);
    const events: ConflictEvent[] = [];
    detector.onConflict((e) => events.push(e));

    expect(() => Y.applyUpdate(raw, updA)).not.toThrow();
    // The second, conflicting update is the one whose top-level parent
    // resolution hits the bare-AbstractType path on a truly fresh doc.
    expect(() => Y.applyUpdate(raw, updB)).not.toThrow();

    // The doc must still be fully usable after the (formerly-crashing)
    // transaction — both a read and a fresh local write.
    expect(raw.getMap('entities').has('E1')).toBe(true);
    const meta = raw.getMap('meta');
    expect(() => meta.set('probe', 1)).not.toThrow();
    expect(meta.get('probe')).toBe(1);
  });

  it('no-regression: a genuine single-client local edit reports no conflict', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
    const detector = createConflictDetector(doc, { windowMs: 60_000 });
    const events: ConflictEvent[] = [];
    detector.onConflict((e) => events.push(e));

    doc.transact(() => setAttribute(doc, 'wall', 'Name', 'Solo'));

    expect(events).toEqual([]);
  });
});

describe('#5215 finding 1: batched vs unbatched multi-client attribution', () => {
  function sharedBaseline(): { base: Y.Doc; baseUpdate: Uint8Array } {
    const base = createCollabDoc();
    createEntity(base, 'wall', { ifcClass: 'IfcWall' });
    return { base, baseUpdate: Y.encodeStateAsUpdate(base) };
  }

  function forkFrom(baseUpdate: Uint8Array): Y.Doc {
    const doc = createCollabDoc();
    Y.applyUpdate(doc, baseUpdate);
    return doc;
  }

  it('the same conflict is detected whether delivered batched (one applyUpdate, two clients) or unbatched (two transactions)', () => {
    const { base, baseUpdate } = sharedBaseline();
    const sv = Y.encodeStateVector(base);

    const peerA = forkFrom(baseUpdate);
    const peerB = forkFrom(baseUpdate);
    peerA.transact(() => setAttribute(peerA, 'wall', 'Name', 'FromA'));
    peerB.transact(() => setAttribute(peerB, 'wall', 'Name', 'FromB'));

    const updA = Y.encodeStateAsUpdate(peerA, sv);
    const updB = Y.encodeStateAsUpdate(peerB, sv);

    // Batched: a relay/catch-up-style single update carrying both
    // clients' structs, applied in ONE Y.applyUpdate call.
    const batchedDoc = forkFrom(baseUpdate);
    const batchedEvents: ConflictEvent[] = [];
    createConflictDetector(batchedDoc, { windowMs: 60_000 }).onConflict((e) =>
      batchedEvents.push(e),
    );
    const merged = Y.mergeUpdates([updA, updB]);
    Y.applyUpdate(batchedDoc, merged);

    // Control: the identical edits delivered as two separate transactions.
    const unbatchedDoc = forkFrom(baseUpdate);
    const unbatchedEvents: ConflictEvent[] = [];
    createConflictDetector(unbatchedDoc, { windowMs: 60_000 }).onConflict((e) =>
      unbatchedEvents.push(e),
    );
    Y.applyUpdate(unbatchedDoc, updA);
    Y.applyUpdate(unbatchedDoc, updB);

    const nameConflict = (e: ConflictEvent) =>
      e.kind === 'attribute' && e.path === 'wall' && e.field === 'Name';

    expect(batchedEvents.some(nameConflict)).toBe(true);
    expect(unbatchedEvents.some(nameConflict)).toBe(true);
  });

  it('no-regression: an ordinary two-transaction conflict still reports exactly one event with its contributor intact', () => {
    const { base, baseUpdate } = sharedBaseline();
    const sv = Y.encodeStateVector(base);

    const peerA = forkFrom(baseUpdate);
    const peerB = forkFrom(baseUpdate);
    peerA.transact(() => setAttribute(peerA, 'wall', 'Name', 'FromA'));
    peerB.transact(() => setAttribute(peerB, 'wall', 'Name', 'FromB'));

    const updA = Y.encodeStateAsUpdate(peerA, sv);
    const updB = Y.encodeStateAsUpdate(peerB, sv);

    const doc = forkFrom(baseUpdate);
    const events: ConflictEvent[] = [];
    createConflictDetector(doc, { windowMs: 60_000 }).onConflict((e) => events.push(e));

    Y.applyUpdate(doc, updA);
    Y.applyUpdate(doc, updB);

    const nameConflicts = events.filter(
      (e) => e.kind === 'attribute' && e.path === 'wall' && e.field === 'Name',
    );
    expect(nameConflicts).toHaveLength(1);
    expect(nameConflicts[0].contributors.length).toBeGreaterThanOrEqual(1);
    expect(new Set(nameConflicts[0].contributors).size).toBe(nameConflicts[0].contributors.length);
  });
});
