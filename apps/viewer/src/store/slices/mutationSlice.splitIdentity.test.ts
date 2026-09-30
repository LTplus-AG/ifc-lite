/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The split identity policy end to end (#6233, charter #6232 "Decisions"):
 * the larger piece keeps the source entity (express id + GlobalId), a tie
 * keeps the piece holding the start, the one new piece gets the v5 GlobalId
 * of `<source>/split/<k>` with k probed past existing ids, and one Ctrl+Z
 * restores exactly the original element.
 *
 * Elements are authored through the same slice builders the Model workspace
 * uses, in a millimetre file (the demo project's unit). Both pieces are
 * re-meshed, and sent to the room, by the wasm re-mesh service when
 * `element.split`'s transaction commits (`element-split.authored.test.tsx`).
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { uuidToIfcGuid, uuidV5 } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { readAttributes } from '@/lib/placement-core';
import { SPLIT_GLOBALID_NAMESPACE } from '@/lib/split-guid';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';

const WALL_GUID = '2XQ$n5SLP5MBLyL442paFx';
const derived = (source: string, k: number) => uuidToIfcGuid(uuidV5(SPLIT_GLOBALID_NAMESPACE, `${source}/split/${k}`));

function created(result: { expressId: number } | { error: string }): number {
  assert.ok('expressId' in result, `builder failed: ${'error' in result ? result.error : ''}`);
  return result.expressId;
}

function guidOf(expressId: number): unknown {
  const s = useViewerStore.getState();
  const dataStore = s.models.get(MODEL_ID)?.ifcDataStore;
  const view = s.mutationViews.get(MODEL_ID);
  const editor = s.storeEditors.get(MODEL_ID);
  assert.ok(dataStore && view && editor);
  return readAttributes(dataStore, view, editor, expressId)?.[0];
}

function wall(guid = WALL_GUID, length = 5): number {
  return created(useViewerStore.getState().addWall(MODEL_ID, STOREY, {
    Start: [0, 0, 0], End: [length, 0, 0], Thickness: 0.2, Height: 2.5, GlobalId: guid,
  }));
}

function split(id: number, distance: number) {
  const result = useViewerStore.getState().splitWallAtDistance(MODEL_ID, id, distance);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result;
}

/** Storey-local [startX, endX] of a wall's axis. */
function span(expressId: number): [number, number] | null {
  const ends = useViewerStore.getState().readWallEndpoints(MODEL_ID, expressId);
  return ends ? [Math.round(ends.start[0] * 1e6) / 1e6, Math.round(ends.end[0] * 1e6) / 1e6] : null;
}

describe('split identity policy (#6233)', () => {
  beforeEach(() => seedModelingSession({ unit: 'millimetre' }));

  it('the longer piece keeps the source; the new piece gets <source>/split/0', () => {
    const id = wall();
    const result = split(id, 1.5); // 1.5 m | 3.5 m → the far piece is longer
    if (!result.ok) return;
    assert.equal(result.right.expressId, id, 'the longer (far) piece is the source entity');
    assert.equal(guidOf(id), WALL_GUID, 'and keeps its GlobalId');
    assert.equal(guidOf(result.left.expressId), derived(WALL_GUID, 0));
    assert.deepEqual(span(id), [1.5, 5], 'the source is reshaped to its piece');
    assert.deepEqual(span(result.left.expressId), [0, 1.5]);
  });

  it('a tie keeps the piece holding the axis start', () => {
    const id = wall(WALL_GUID, 4);
    const result = split(id, 2);
    if (!result.ok) return;
    assert.equal(result.left.expressId, id);
    assert.equal(guidOf(result.right.expressId), derived(WALL_GUID, 0));
  });

  it('is deterministic across two independent stores', async () => {
    const first = split(wall(), 1); // 1 | 4: the new piece is the left one
    const firstGuid = first.ok ? guidOf(first.left.expressId) : null;
    await seedModelingSession({ unit: 'millimetre' });
    const second = split(wall(), 3.2); // 3.2 | 1.8, a different cut: the new piece is the right one
    assert.ok(second.ok);
    assert.equal(firstGuid, derived(WALL_GUID, 0));
    assert.equal(guidOf(second.right.expressId), firstGuid, 'same source, same id, whatever the cut');
  });

  it('probes past an id that already exists in the model', () => {
    wall(derived(WALL_GUID, 0), 2); // an unrelated element already carries k = 0
    const result = split(wall(), 1); // 1 | 4: the new piece is the left one
    if (!result.ok) return;
    assert.equal(guidOf(result.left.expressId), derived(WALL_GUID, 1));
  });

  it('splitting the kept piece again yields k = 1; splitting a child derives from the child', () => {
    const id = wall(WALL_GUID, 6);
    const once = split(id, 1); // keeps [1, 6] as the source; new [0, 1] = k0
    assert.ok(once.ok && once.right.expressId === id);
    const twice = split(id, 1); // source is now 5 m long: keeps [2, 6], new [1, 2] = k1
    assert.ok(twice.ok && twice.right.expressId === id);
    assert.equal(guidOf(twice.left.expressId), derived(WALL_GUID, 1));

    const child = once.ok ? once.left.expressId : -1; // 1 m, GlobalId k0
    const grandchild = split(child, 0.3);
    assert.ok(grandchild.ok && grandchild.right.expressId === child);
    assert.equal(guidOf(grandchild.left.expressId), derived(derived(WALL_GUID, 0), 0));
  });

  it('one undo restores exactly the original element; redo re-applies the split', () => {
    const id = wall();
    const before = useViewerStore.getState().readWallEndpoints(MODEL_ID, id);
    const result = split(id, 1.5);
    if (!result.ok) return;
    const newId = result.left.expressId;

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(useViewerStore.getState().readWallEndpoints(MODEL_ID, id), before, 'source geometry restored');
    assert.equal(guidOf(id), WALL_GUID, 'same GlobalId on the same express id');
    assert.equal(span(newId), null, 'the new piece is gone');
    assert.equal(useViewerStore.getState().canUndo(MODEL_ID), true, "only the wall's own create is left");

    useViewerStore.getState().redo(MODEL_ID);
    assert.deepEqual(span(id), [1.5, 5]);
    assert.deepEqual(span(newId), [0, 1.5]);
    assert.equal(guidOf(newId), derived(WALL_GUID, 0));
  });

  it('linear elements and slabs follow the same policy', () => {
    const s = useViewerStore.getState();
    const beam = created(s.addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.3, GlobalId: WALL_GUID }));
    const b = useViewerStore.getState().splitLinearElementAtDistance(MODEL_ID, beam, 3);
    assert.ok(b.ok && b.left.expressId === beam, 'the 3 m first piece keeps the beam');
    assert.equal(guidOf(b.ok ? b.right.expressId : -1), derived(WALL_GUID, 0));

    const slabGuid = '1kTvXnbbzCWw8lcMd1dR4q';
    const slab = created(useViewerStore.getState().addSlab(MODEL_ID, STOREY, {
      Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2, GlobalId: slabGuid,
    }));
    const cut = useViewerStore.getState().splitSlabByLine(MODEL_ID, slab, [3, -1], [3, 4]);
    assert.ok(cut.ok);
    if (!cut.ok) return;
    const kept = cut.left.expressId === slab ? cut.left : cut.right;
    const added = kept === cut.left ? cut.right : cut.left;
    const area = (id: number) => {
      const fp = useViewerStore.getState().readSlabFootprint(MODEL_ID, id)?.footprint ?? [];
      return Math.abs(fp.reduce((a, [x1, y1], i) => { const [x2, y2] = fp[(i + 1) % fp.length]; return a + x1 * y2 - x2 * y1; }, 0) / 2);
    };
    assert.ok(Math.abs(area(kept.expressId) - 9) < 1e-6, 'the 9 m² piece keeps the slab');
    assert.ok(Math.abs(area(added.expressId) - 3) < 1e-6);
    assert.equal(guidOf(slab), slabGuid);
    assert.equal(guidOf(added.expressId), derived(slabGuid, 0));
  });
});
