/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `overlay-tombstones.ts` used to store the whole tombstoned-path set as
 * one JSON array under a single `meta` key, read-modify-written on every
 * `applyIfcxOverlay` call. Two peers, forked from the same doc state,
 * each tombstoning a DIFFERENT path before syncing, both read the same
 * starting array, each add their own path, and each write their whole
 * array back — Yjs resolves that single key last-write-wins, so whichever
 * peer's array landed last silently discarded the other's path, even
 * though both peers converged (to the same, wrong, answer).
 *
 * The fix moves storage to a dedicated per-path `Y.Map` (one registry key
 * per path), so two peers tombstoning different paths touch different
 * keys and both survive the merge. These tests exercise the fix at the
 * Yjs update-sync level (`encodeStateAsUpdate` / `applyUpdate`), not just
 * the in-memory helpers, to pin actual CRDT convergence.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import { createCollabDoc, entitiesMap, metaMap } from '../src/doc/schema.js';
import { createEntity, deleteEntity } from '../src/doc/entity.js';
import { applyIfcxOverlay } from '../src/snapshot/from-ifcx.js';

function layer(data: IfcxFile['data']): IfcxFile {
  return {
    header: {
      id: 'overlay-tombstones-concurrency-fixture',
      ifcxVersion: 'IFCX-1.0',
      dataVersion: '1.0',
      author: 'test',
      timestamp: '2020-01-01T00:00:00Z',
    },
    schemas: {},
    data,
  };
}

/** Fork `source` into an independent doc holding the same state so far. */
function fork(source: Y.Doc): Y.Doc {
  const doc = createCollabDoc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function sync(a: Y.Doc, b: Y.Doc): void {
  const updA = Y.encodeStateAsUpdate(a);
  const updB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, updB);
  Y.applyUpdate(b, updA);
}

describe('overlay-tombstones concurrency', () => {
  it('two concurrent overlay calls tombstoning different paths both survive the merge', () => {
    const base = createCollabDoc({ gc: false });
    base.transact(() => {
      createEntity(base, 'wall', { ifcClass: 'IfcWall' });
      createEntity(base, 'door', { ifcClass: 'IfcDoor' });
    });

    const docA = fork(base);
    const docB = fork(base);

    // Peer A tombstones /wall; peer B, concurrently (before seeing A's
    // update), tombstones /door.
    applyIfcxOverlay(docA, layer([{ path: 'wall', attributes: { [IFCLITE_ATTR.DELETED]: true } }]));
    applyIfcxOverlay(docB, layer([{ path: 'door', attributes: { [IFCLITE_ATTR.DELETED]: true } }]));

    sync(docA, docB);

    // Both deletions must be visible, and converged, on both peers.
    expect(entitiesMap(docA).has('wall')).toBe(false);
    expect(entitiesMap(docA).has('door')).toBe(false);
    expect(entitiesMap(docB).has('wall')).toBe(false);
    expect(entitiesMap(docB).has('door')).toBe(false);

    // The regression this bug caused: a later, third call with no opinion
    // on the dropped path must not resurrect it (`resurrectionBlocked`'s
    // own contract, now proven across a real merge instead of just one
    // doc's local calls).
    applyIfcxOverlay(docA, layer([{ path: 'wall', attributes: { 'ifclite::name': 'unrelated edit' } }]));
    applyIfcxOverlay(docA, layer([{ path: 'door', attributes: { 'ifclite::name': 'unrelated edit' } }]));
    expect(entitiesMap(docA).has('wall')).toBe(false);
    expect(entitiesMap(docA).has('door')).toBe(false);
  });

  it('a doc carrying the legacy single-array tombstone blob still blocks resurrection', () => {
    const doc = createCollabDoc({ gc: false });
    doc.transact(() => createEntity(doc, 'wall', { ifcClass: 'IfcWall' }));

    // Simulate a doc written by the OLD code: 'wall' already purged from
    // entitiesMap (as `deleteEntity` does) and the tombstone recorded as a
    // single JSON array under the legacy meta key, with nothing in the
    // new per-path registry (a doc "in the wild" from before this fix).
    doc.transact(() => {
      deleteEntity(doc, 'wall');
      metaMap(doc).set('overlay.tombstonedPaths', ['wall']);
    });
    expect(entitiesMap(doc).has('wall')).toBe(false);

    // A later call touching 'wall' with no opinion on deletion must not
    // resurrect it: the migration path (folding the legacy array into the
    // effective tombstone set) must still work under the new storage.
    applyIfcxOverlay(
      doc,
      layer([
        { path: 'wall', attributes: { 'ifclite::name': 'no opinion, must stay dead' } },
        { path: 'door', attributes: { 'ifclite::name': 'Door A' } },
      ]),
    );

    expect(entitiesMap(doc).has('wall')).toBe(false);
    expect(entitiesMap(doc).has('door')).toBe(true);
  });

  it('single-peer tombstoning across separate overlay calls still works (no regression)', () => {
    const doc = createCollabDoc({ gc: false });
    doc.transact(() => createEntity(doc, 'wall', { ifcClass: 'IfcWall' }));

    applyIfcxOverlay(doc, layer([{ path: 'wall', attributes: { [IFCLITE_ATTR.DELETED]: true } }]));
    expect(entitiesMap(doc).has('wall')).toBe(false);

    applyIfcxOverlay(doc, layer([{ path: 'wall', attributes: { 'ifclite::name': 'no opinion on deletion' } }]));
    expect(entitiesMap(doc).has('wall')).toBe(false);
  });
});
