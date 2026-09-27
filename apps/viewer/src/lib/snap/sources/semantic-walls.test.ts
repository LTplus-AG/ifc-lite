/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * storeyWallAxes (#6232 WP3): the semantic snap source's wall axes, on real
 * parsed stores. The interesting case is a SOURCE wall moved this session:
 * `extractWallSegmentsForStorey` reads source walls from the source bytes, so
 * without the edit-chain override a moved wall would snap at its old place.
 * The fixture for that is an ifc-lite-authored wall round-tripped through the
 * STEP exporter, which makes it a source wall with a resolvable edit chain.
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
    const axes = storeyWallAxes(s.store, s.view, s.editor, STOREY);
    assert.deepEqual(axes.map((w) => w.expressId), ex.contributingWallIds);
    assert.deepEqual(axes.map((w) => [w.a, w.b]), ex.segments.map((g) => [g.a, g.b]));
    const w = axes.find((x) => x.expressId === created);
    assert.ok(w && close(w.a, [2, 5]) && close(w.b, [8, 5]));
  });

  it('follows a SOURCE wall moved this session, where the source-byte extraction goes stale', async () => {
    // Author a wall, export, re-open: it is now a source wall with an edit chain.
    const authoring = await session();
    addWall(authoring, [1, 2], [6, 2]);
    const { content } = new StepExporter(authoring.store, authoring.view).export({ schema: 'IFC4', applyMutations: true });
    const s = await session(content);
    const before = storeyWallAxes(s.store, s.view, s.editor, STOREY);
    const moved = before.find((w) => close(w.a, [1, 2]) && close(w.b, [6, 2]));
    assert.ok(moved, 're-opened wall axis present');

    const res = resizeRectangleWall(s.store, s.view, s.editor, moved.expressId, [1, 4, 0], [7, 4, 0]);
    assert.ok(res.ok, res.ok ? '' : res.reason);

    const stale = extractWallSegmentsForStorey(s.store, STOREY, s.view);
    const staleSeg = stale.segments[stale.contributingWallIds.indexOf(moved.expressId)];
    assert.ok(close(staleSeg.a, [1, 2]), 'control: the source-byte extraction still has the old axis');

    const live = storeyWallAxes(s.store, s.view, s.editor, STOREY).find((w) => w.expressId === moved.expressId);
    assert.ok(live && close(live.a, [1, 4]) && close(live.b, [7, 4]), JSON.stringify(live));
  });
});
