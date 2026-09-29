/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads behind the Model workspace's hosted placement (#6232 A1): the host
 * wall's frame on its storey, and an opening's Offset and Sill read back from
 * the live overlay, for a window in the wall of a real Bonsai export
 * (hello-wall.ifc, `#1222`) and in a wall authored this session.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { placedBodyExtent, resolveHostAnchor } from './resolve-host.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addOpeningToStore } from './opening.js';
import { addHostedWindowToStore } from './hosted-fill.js';
import { addWallToStore } from './wall.js';
import { addWindowToStore } from './window.js';
import { hostPlanFrame, readHostedFill } from './hosted-fill-read.js';

const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const WALL = 1222;
const STOREY = 42;

async function session() {
  const bytes = await readFile(SAMPLE);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  return { store, view, editor };
}

describe('hostPlanFrame', () => {
  it('reads a file wall at its placement, running along its RefDirection', async () => {
    const { store, view } = await session();
    const frame = hostPlanFrame(store, WALL, STOREY, view)!;
    expect(frame.origin.map((v) => +v.toFixed(9))).toEqual([0, 0, 0]);
    expect(frame.axisX.map((v) => +v.toFixed(9))).toEqual([1, 0]);
  });

  it('reads a wall authored this session, turned and off the origin', async () => {
    const { store, view, editor } = await session();
    const wall = addWallToStore(editor, resolveSpatialAnchor(store, STOREY, view), {
      Start: [2, 1, 0.5], End: [2, 5, 0.5], Thickness: 0.2, Height: 3,
    }).wallId;
    const frame = hostPlanFrame(store, wall, STOREY, view)!;
    expect(frame.origin.map((v) => +v.toFixed(9))).toEqual([2, 1, 0.5]);
    expect(frame.axisX.map((v) => +v.toFixed(9))).toEqual([0, 1]);
  });
});

describe('readHostedFill', () => {
  it('reads a hosted window, from the window or its opening, as the Offset and Sill it was built with', async () => {
    const { store, view, editor } = await session();
    const built = addHostedWindowToStore(editor, resolveHostAnchor(store, WALL, view), { Offset: 4, Sill: 0.9, Width: 1.2, Height: 1.4 });
    const expected = { hostId: WALL, openingId: built.opening.openingId, fillingId: built.fillingId, offset: 4, sill: 0.9 };
    expect(readHostedFill(store, built.fillingId, view)).toMatchObject(expected);
    expect(readHostedFill(store, built.opening.openingId, view)).toMatchObject(expected);
  });

  it('follows an edit of the opening Location, and a bare opening has no filling', async () => {
    const { store, view, editor } = await session();
    const opening = addOpeningToStore(editor, resolveHostAnchor(store, WALL, view), { Offset: 2, Sill: 1, Width: 1, Height: 1 });
    const read = readHostedFill(store, opening.openingId, view)!;
    expect(read).toMatchObject({ fillingId: null, offset: 2, sill: 1 });
    editor.setPositionalAttribute(read.locationPointId, 0, [6, read.location[1], 0.25]);
    expect(readHostedFill(store, opening.openingId, view)).toMatchObject({ offset: 6, sill: 0.25 });
  });

  it('is null for a free-standing window, a wall, and a deleted opening', async () => {
    const { store, view, editor } = await session();
    const free = addWindowToStore(editor, resolveSpatialAnchor(store, STOREY, view), { Position: [1, 1, 0], Width: 1, Height: 1 }).windowId;
    expect(readHostedFill(store, free, view)).toBeNull();
    expect(readHostedFill(store, WALL, view)).toBeNull();
    const opening = addOpeningToStore(editor, resolveHostAnchor(store, WALL, view), { Offset: 2, Width: 1, Height: 1 });
    editor.removeEntity(opening.openingId);
    expect(readHostedFill(store, opening.openingId, view)).toBeNull();
  });
});

describe('placedBodyExtent', () => {
  it("measures an opening's cut in its host's frame, through the opening's turned placement", async () => {
    const { store, view, editor } = await session();
    const opening = addOpeningToStore(editor, resolveHostAnchor(store, WALL, view), { Offset: 4, Sill: 0.9, Width: 1.2, Height: 1.5 });
    const extent = placedBodyExtent(store, opening.openingId, view)!;
    const r = (v: number[]) => v.map((x) => +x.toFixed(9));
    // Along the wall and up it: exactly the Width x Height it was cut with.
    expect([r(extent.min)[0], r(extent.max)[0]]).toEqual([3.4, 4.6]);
    expect([r(extent.min)[2], r(extent.max)[2]]).toEqual([0.9, 2.4]);
  });

  it('is null for an entity with no body', async () => {
    const { store, view } = await session();
    expect(placedBodyExtent(store, STOREY, view)).toBeNull();
  });
});
