/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5642: a wall created on one storey bounded rooms on every storey.
 *
 * `extractWallSegmentsForStorey` added EVERY overlay-created divider to the
 * storey being processed, without checking containment. The spatial walk
 * (`buildRelatingChildrenIndex`) already indexes overlay-created
 * IfcRelContainedInSpatialStructure, and every authoring path writes one, so
 * created dividers must come from that walk like source ones.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';
import { extractWallSegmentsForStorey } from './extract-walls.js';

// Bonsai/IfcOpenShell IFC4 sample, with one parsed storey (#42).
const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);

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

/** An overlay-created storey with its own placement, under no aggregate. */
function addStorey(editor: StoreEditor): number {
  const point = editor.addEntity('IfcCartesianPoint', [[0, 0, 3]]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
  const placement = editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
  const storey = editor.addEntity('IfcBuildingStorey', [
    '0Storey000000000000005', null, 'Level 1', null, null,
    null, null, null, '.ELEMENT.', 3,
  ]).expressId;
  editor.setPositionalAttribute(storey, 5, `#${placement}`);
  return storey;
}

/** Four walls closing a 5 x 5 m room at `origin`, authored on `storeyId`. */
function addRoom(editor: StoreEditor, store: Awaited<ReturnType<typeof session>>['store'], view: MutablePropertyView, storeyId: number, origin: number): number[] {
  const anchor = resolveSpatialAnchor(store, storeyId, view);
  const corners = [[origin, origin], [origin + 5, origin], [origin + 5, origin + 5], [origin, origin + 5]] as const;
  const ids: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const start = corners[i]!;
    const end = corners[(i + 1) % corners.length]!;
    ids.push(addWallToStore(editor, anchor, {
      Start: [start[0], start[1], 0], End: [end[0], end[1], 0], Thickness: 0.2, Height: 3,
    }).wallId);
  }
  return ids;
}

describe('extractWallSegmentsForStorey: created walls stay on their storey (#5642)', () => {
  it('does not bound storey 42 with walls authored on another storey', async () => {
    const { store, view, editor } = await session();
    const level1 = addStorey(editor);
    const upstairs = addRoom(editor, store, view, level1, 100);

    const onGround = extractWallSegmentsForStorey(store, 42, editor);
    for (const id of upstairs) expect(onGround.contributingWallIds).not.toContain(id);

    const onLevel1 = extractWallSegmentsForStorey(store, level1, editor);
    expect([...onLevel1.contributingWallIds].sort()).toEqual([...upstairs].sort());
  });

  it('still bounds a storey with the walls authored on it', async () => {
    const { store, view, editor } = await session();
    const ground = addRoom(editor, store, view, 42, 100);
    const onGround = extractWallSegmentsForStorey(store, 42, editor);
    for (const id of ground) expect(onGround.contributingWallIds).toContain(id);
  });
});
