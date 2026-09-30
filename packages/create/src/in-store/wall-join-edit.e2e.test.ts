/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End to end for the wall-join editing (#6232 B2): a closed room joined at all
 * four corners, then a shared corner dragged, exported and meshed through the
 * real wasm geometry pipeline. Ray parity at each corner: no sample point may
 * be inside both neighbouring wall meshes (no overlapping volume), and the
 * corner must be solid (each corner has a body there). The file is then
 * re-parsed and edited again, so joins written by source-entity reads count.
 *
 * The wasm half skips (never fails) when `packages/wasm/pkg/ifc-lite_bg.wasm`
 * is not built on this host.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { addWallToStore } from './wall.js';
import { joinWallsInStore, reshapeWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { readWallJoinRels } from './wall-join-read.js';
import { HEIGHT, exportText, meshWalls, newStorey, parse, sample } from './wall-join-mesh.oracle.js';
import type { PlanPoint } from './wall-join.js';

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const WASM_AVAILABLE = existsSync(WASM_PATH);

/** A skewed room, so two of its corners are oblique and their bodies are polygons. */
const CORNERS: PlanPoint[] = [[0, 0], [6, 0], [7, 4], [1, 4]];

async function joinedRoom(corners: PlanPoint[]) {
  const s = await newStorey();
  const ids = corners.map((p, i) => {
    const q = corners[(i + 1) % corners.length];
    return addWallToStore(s.editor, s.anchor, { Start: [p[0], p[1], 0], End: [q[0], q[1], 0], Thickness: 0.2, Height: HEIGHT, Axis: true }).wallId;
  });
  ids.forEach((id, i) => joinWallsInStore(s.editor, s.store, s.joinAnchor, id, ids[(i + 1) % ids.length]));
  return { ...s, ids };
}

/** Every corner of the room: no overlap between the two walls meeting there, and a body on it. */
function expectCleanCorners(api: IfcAPI, text: string, ids: number[], corners: PlanPoint[]): void {
  const meshes = meshWalls(api, text);
  corners.forEach((corner, i) => {
    const a = meshes.get(ids[(i + ids.length - 1) % ids.length]) ?? [];
    const b = meshes.get(ids[i]) ?? [];
    expect(a.length, `wall before corner ${i} has a mesh`).toBeGreaterThan(0);
    expect(b.length, `wall after corner ${i} has a mesh`).toBeGreaterThan(0);
    const tally = sample(a, b, corner);
    expect(tally.inside, `corner ${i} is solid`).toBeGreaterThan(100);
    expect(tally.both, `corner ${i} has no overlapping volume`).toBe(0);
  });
}

describe.skipIf(!WASM_AVAILABLE)('a joined room, then a dragged corner (#6232 B2)', () => {
  let api: IfcAPI;
  beforeAll(() => {
    initSync({ module: readFileSync(WASM_PATH) });
    api = new IfcAPI();
  });

  it('four chained joins leave every corner clean', async () => {
    const s = await joinedRoom(CORNERS);
    expectCleanCorners(api, exportText(s), s.ids, CORNERS);
  });

  it('without joins the same room overlaps at its corners (the oracle can see it)', async () => {
    const s = await newStorey();
    const ids = CORNERS.map((p, i) => {
      const q = CORNERS[(i + 1) % 4];
      return addWallToStore(s.editor, s.anchor, { Start: [p[0], p[1], 0], End: [q[0], q[1], 0], Thickness: 0.2, Height: HEIGHT }).wallId;
    });
    const meshes = meshWalls(api, exportText(s));
    expect(sample(meshes.get(ids[3]) ?? [], meshes.get(ids[0]) ?? [], CORNERS[0]).both).toBeGreaterThan(0);
  });

  it('dragging a shared corner moves both walls and every corner stays clean', async () => {
    const s = await joinedRoom(CORNERS);
    const moved: PlanPoint = [7.5, 0.8];
    reshapeWallsInStore(s.editor, s.store, s.joinAnchor, [{ wallId: s.ids[0], end: moved }], { moveJoinedEnds: true });
    const text = exportText(s);
    expectCleanCorners(api, text, s.ids, [CORNERS[0], moved, CORNERS[2], CORNERS[3]]);
    expect(readWallJoinRels(s.store, s.editor.getMutationView())).toHaveLength(4);
  });

  it('a room re-parsed from its file keeps the joins and can be dragged again', async () => {
    const first = await joinedRoom(CORNERS);
    const text = exportText(first);
    const store = await parse(text);
    // Four joins survive the file, each pair related both ways.
    expect(store.entityIndex.byType.get('IFCRELCONNECTSPATHELEMENTS')).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const a = first.ids[i];
      const b = first.ids[(i + 1) % 4];
      const related = [
        ...store.relationships.getRelated(a, RelationshipType.ConnectsPathElements, 'forward'),
        ...store.relationships.getRelated(a, RelationshipType.ConnectsPathElements, 'inverse'),
      ];
      expect(related).toContain(b);
    }

    const view = new MutablePropertyView(null, 'm');
    view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
    const editor = new StoreEditor(store, view);
    expect(readWallJoinRels(store, view)).toHaveLength(4);
    const anchor = resolveWallJoinAnchor(store, view);
    const moved: PlanPoint = [6.5, -0.6];
    reshapeWallsInStore(editor, store, anchor, [{ wallId: first.ids[0], end: moved }], { moveJoinedEnds: true });
    const exported = exportText({ store, view, schema: 'IFC4' });
    expectCleanCorners(api, exported, first.ids, [CORNERS[0], moved, CORNERS[2], CORNERS[3]]);
    expect(readWallJoinRels(store, view)).toHaveLength(4);
  });
});
