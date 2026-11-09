/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { AnchorEntityReader } from './resolve-anchor.js';
import { transformElementsInStore } from './element-transform-edit.js';
import { readWallJoinRels, readWallJoinTarget } from './wall-join-read.js';

const fixture = new URL('../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
type Point = [number, number];
type Frame = (point: Point) => Point;

// Read the written extrusion, independently of wallBodyOutline/readWallJoinTarget
// and the join solver. Compose the file's actual placement chain and solid frame.
function polygon(reader: AnchorEntityReader, id: number): Point[] {
  const entity = (ref: unknown) => {
    const value = reader.entity(Number(String(ref).replace('#', '')));
    if (!value) throw new Error(`Missing fixture record ${String(ref)}`);
    return value;
  };
  const frame = (ref: unknown): Frame => {
    const axis = entity(ref);
    const origin = entity(axis.attributes[0]).attributes[0] as number[];
    const direction = axis.attributes[2] == null ? [1, 0] : entity(axis.attributes[2]).attributes[0] as number[];
    const length = Math.hypot(direction[0], direction[1]);
    const [dx, dy] = [direction[0] / length, direction[1] / length];
    return ([x, y]) => [origin[0] + dx * x - dy * y, origin[1] + dy * x + dx * y];
  };
  const product = entity(id);
  const frames: Frame[] = [];
  let placement = product.attributes[5];
  const seen = new Set<unknown>();
  while (placement != null) {
    if (seen.has(placement)) throw new Error('Cyclic fixture placement');
    seen.add(placement);
    const local = entity(placement);
    frames.push(frame(local.attributes[1]));
    placement = local.attributes[0];
  }
  const shape = entity(product.attributes[6]);
  const body = (shape.attributes[2] as unknown[]).map(entity).find(r => r.attributes[1] === 'Body');
  if (!body) throw new Error('Missing Body');
  const solid = entity((body.attributes[3] as unknown[])[0]);
  const profile = entity(solid.attributes[0]);
  expect(profile.type.toUpperCase()).toBe('IFCARBITRARYCLOSEDPROFILEDEF');
  const curve = entity(profile.attributes[2]);
  return (curve.attributes[0] as unknown[]).map(ref => {
    const xy = entity(ref).attributes[0] as Point;
    return [frame(solid.attributes[1]), ...frames].reduce((p, apply) => apply(p), xy);
  });
}

function contains(points: Point[], expected: Point): void {
  expect(Math.min(...points.map(p => Math.hypot(p[0] - expected[0], p[1] - expected[1])))).toBeLessThan(2e-8);
}

for (const fullGraph of [false, true]) {
  it(`#9296 F6 moved imported corner has correct butt faces on BOTH walls; full graph=${fullGraph}`, async t => {
    if (!existsSync(fixture)) { t.skip('FZK fixture missing; run pnpm fixtures'); return; }
    const bytes = readFileSync(fixture);
    const dataStore = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'f6');
    const editor = new StoreEditor(dataStore, view);
    if (!fullGraph) {
      for (const id of dataStore.entityIndex.byType.get('IFCRELCONNECTSPATHELEMENTS') ?? []) {
        if (id !== 17049) editor.removeEntity(id);
      }
    }
    const before = polygon(new AnchorEntityReader(dataStore, view), 15042);
    expect(Math.min(...before.map(p => p[0]))).toBeCloseTo(7.41, 8);
    const result = editor.runAtomic(draft => transformElementsInStore({ dataStore, editor: draft, view: draft.getMutationView(), selected: [15042], op: { kind: 'move', delta: [1, 0] } }));
    expect(result.remesh).toEqual(expect.arrayContaining([15042, 17040]));
    expect(readWallJoinTarget(dataStore, view, 17040, 1)?.wall.start).toEqual([7.41, 10]);
    expect(readWallJoinTarget(dataStore, view, 17040, 1)?.wall.end).toEqual([8.41, 4.25]);
    expect(readWallJoinTarget(dataStore, view, 15042, 1)?.location).toEqual([8.41, 4.25, 0]);

    // #17040 runs from (7.41,10) to the carried joint (8.41,4.25).
    // Its left face is n dot (p-joint)=.24, n=(5.75,1)/hypot(5.75,1).
    // Intersect that face with #15042's two horizontal faces, y=4.01,4.25.
    const norm = Math.hypot(5.75, 1);
    const nx = 5.75 / norm, ny = 1 / norm;
    const faceX = (y: number) => 8.41 + (.24 - ny * (y - 4.25)) / nx;
    const sharedTop: Point = [faceX(4.25), 4.25];
    const sharedBottom: Point = [faceX(4.01), 4.01];

    const check = (reader: AnchorEntityReader) => {
      const moved = polygon(reader, 15042), neighbour = polygon(reader, 17040);
      contains(moved, sharedTop); contains(moved, sharedBottom);
      // The neighbour's side contains the shared segment and ends at the
      // moved wall's outer face. It must not remain on its former vertical axis.
      contains(neighbour, sharedBottom);
      contains(neighbour, [8.41 + .24 / 5.75, 4.01]);
      if (!fullGraph) contains(neighbour, [7.41, 10]);
      expect(Math.min(...moved.map(p => p[0])) - 7.41).toBeCloseTo(1.243602453, 8);
      for (const p of moved) expect(nx * (p[0] - 8.41) + ny * (p[1] - 4.25)).toBeGreaterThanOrEqual(.24 - 2e-8);
      for (const p of neighbour) expect(nx * (p[0] - 8.41) + ny * (p[1] - 4.25)).toBeLessThanOrEqual(.24 + 2e-8);
      // The imported far-end -.3 cut survives the isolated corner. In the
      // full graph, #31484 disconnects: the translated axis now crosses the
      // path wall internally; its former ATEND must become square at x=13.
      expect(Math.max(...moved.map(p => p[0]))).toBeCloseTo(fullGraph ? 13 : 12.7, 8);
    };
    check(new AnchorEntityReader(dataStore, view));
    const rels = readWallJoinRels(dataStore, view, new Set([15042]));
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ relatingId: 17040, relatedId: 15042, relatingConnection: 'ATEND', relatedConnection: 'ATSTART' });

    // The asserted geometry must survive a real STEP export and independent reparse.
    const exported = new StepExporter(dataStore, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const reopened = await new IfcParser().parseColumnar(exported.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    check(new AnchorEntityReader(reopened));
  });
}
