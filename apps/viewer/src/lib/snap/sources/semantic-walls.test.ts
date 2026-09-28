/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * storeyWallAxes (#6232 WP3): the semantic snap source's wall axes, on real
 * parsed stores. The source-wall cases are ifc-lite-authored walls round-
 * tripped through STEP so pending edits exercise source-buffer extraction.
 */

import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addWallToStore, extractWallSegmentsForStorey, resolveSpatialAnchor } from '@ifc-lite/create';
import { StepExporter } from '@ifc-lite/export';
// Production wires the source-entity reader at boot (bootstrap.tsx); the edit chain needs it.
import '@/lib/placement-edit.boot';
import { resizeRectangleWall } from '@/lib/wall-edit';
import { storeyWallAxes } from './semantic-walls.js';

// Bonsai/IfcOpenShell IFC4 sample: one storey (#42) with one wall (#1222).
const SAMPLE = new URL('../../../../public/samples/hello-wall.ifc', import.meta.url);
const STOREY = 42;

async function session(bytes?: Uint8Array) {
  const raw = bytes ?? new Uint8Array(await readFile(SAMPLE));
  const store = await new IfcParser().parseColumnar(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  return { store, view, editor };
}

type Session = Awaited<ReturnType<typeof session>>;

function addWall(s: Session, start: [number, number], end: [number, number]): number {
  const anchor = resolveSpatialAnchor(s.store, STOREY, s.view);
  return addWallToStore(s.editor, anchor, {
    Start: [start[0], start[1], 0], End: [end[0], end[1], 0], Thickness: 0.2, Height: 3,
  }).wallId;
}

const close = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

describe('storeyWallAxes (#6232 WP3)', () => {
  it('matches the canonical extraction for untouched walls, created ones included', async () => {
    const s = await session();
    const created = addWall(s, [2, 5], [8, 5]);
    const ex = extractWallSegmentsForStorey(s.store, STOREY, s.view);
    const axes = storeyWallAxes(s.store, s.view, STOREY);
    assert.deepEqual(axes.map((w) => w.expressId), ex.contributingWallIds);
    assert.deepEqual(axes.map((w) => [w.a, w.b]), ex.segments.map((g) => [g.a, g.b]));
    const w = axes.find((x) => x.expressId === created);
    assert.ok(w && close(w.a, [2, 5]) && close(w.b, [8, 5]));
  });

  it('follows a SOURCE wall moved this session through canonical extraction', async () => {
    // Author a wall, export, re-open: it is now a source wall with an edit chain.
    const authoring = await session();
    addWall(authoring, [1, 2], [6, 2]);
    const { content } = new StepExporter(authoring.store, authoring.view).export({ schema: 'IFC4', applyMutations: true });
    const s = await session(content);
    const before = storeyWallAxes(s.store, s.view, STOREY);
    const moved = before.find((w) => close(w.a, [1, 2]) && close(w.b, [6, 2]));
    assert.ok(moved, 're-opened wall axis present');

    const res = resizeRectangleWall(s.store, s.view, s.editor, moved.expressId, [1, 4, 0], [7, 4, 0]);
    assert.ok(res.ok, res.ok ? '' : res.reason);

    const extracted = extractWallSegmentsForStorey(s.store, STOREY, s.view);
    const extractedSeg = extracted.segments[extracted.contributingWallIds.indexOf(moved.expressId)];
    assert.ok(close(extractedSeg.a, [1, 4]) && close(extractedSeg.b, [7, 4]),
      'canonical extraction reads the pending source-wall edits');

    const live = storeyWallAxes(s.store, s.view, STOREY).find((w) => w.expressId === moved.expressId);
    assert.ok(live && close(live.a, [1, 4]) && close(live.b, [7, 4]), JSON.stringify(live));
  });

  it('composes a moved source wall through an intermediate placement (#6359)', async () => {
    const authoring = await session();
    const anchor = resolveSpatialAnchor(authoring.store, STOREY, authoring.view);
    const point = authoring.editor.addEntity('IfcCartesianPoint', [[10, 0, 0]]).expressId;
    const axis = authoring.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    const intermediate = authoring.editor.addEntity('IfcLocalPlacement', [
      `#${anchor.storeyPlacementId}`, `#${axis}`,
    ]).expressId;
    const wall = addWallToStore(authoring.editor, anchor, {
      Start: [1, 2, 0], End: [6, 2, 0], Thickness: 0.2, Height: 3,
    });
    authoring.editor.setPositionalAttribute(wall.placementId, 0, `#${intermediate}`);
    const { content } = new StepExporter(authoring.store, authoring.view).export({ schema: 'IFC4', applyMutations: true });
    const s = await session(content);
    const before = extractWallSegmentsForStorey(s.store, STOREY, s.view);
    const index = before.segments.findIndex((seg) => close(seg.a, [11, 2]) && close(seg.b, [16, 2]));
    assert.ok(index >= 0, 'source wall starts in the composed storey frame');
    const wallId = before.contributingWallIds[index];

    const result = resizeRectangleWall(s.store, s.view, s.editor, wallId, [1, 4, 0], [7, 4, 0]);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    const extracted = extractWallSegmentsForStorey(s.store, STOREY, s.view);
    const extractedIndex = extracted.contributingWallIds.indexOf(wallId);
    assert.ok(extractedIndex >= 0, 'edited source wall remains in canonical extraction');
    const segment = extracted.segments[extractedIndex];
    assert.ok(close(segment.a, [11, 4]) && close(segment.b, [17, 4]),
      'canonical extraction composes the edited wall with its +10 m parent');
    const snapped = storeyWallAxes(s.store, s.view, STOREY).find((w) => w.expressId === wallId);
    assert.ok(snapped && close(snapped.a, [11, 4]) && close(snapped.b, [17, 4]),
      `snap axis must use the storey frame: ${JSON.stringify(snapped)}`);
  });

  it('returns a moved source wall in metres when the file is in millimetres', async () => {
    const authoring = await session();
    addWall(authoring, [1, 2], [6, 2]);
    const { content } = new StepExporter(authoring.store, authoring.view).export({ schema: 'IFC4', applyMutations: true });
    // Same bytes, but the file now declares millimetres: raw 1 → 0.001 m.
    const text = new TextDecoder().decode(content);
    assert.ok(text.includes('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'), 'fixture declares metres');
    const s = await session(new TextEncoder().encode(text.replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)')));
    const moved = storeyWallAxes(s.store, s.view, STOREY).find((w) => close(w.a, [0.001, 0.002]));
    assert.ok(moved, 'the re-opened wall reads in metres');
    // resizeRectangleWall takes native STEP units (mm here).
    const res = resizeRectangleWall(s.store, s.view, s.editor, moved.expressId, [1000, 4000, 0], [7000, 4000, 0]);
    assert.ok(res.ok, res.ok ? '' : res.reason);
    const live = storeyWallAxes(s.store, s.view, STOREY).find((w) => w.expressId === moved.expressId);
    assert.ok(live && close(live.a, [1, 4]) && close(live.b, [7, 4]), JSON.stringify(live));
  });
});
