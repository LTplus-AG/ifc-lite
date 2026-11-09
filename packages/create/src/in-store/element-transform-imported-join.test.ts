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
  let points: Point[];
  if (profile.type.toUpperCase() === 'IFCRECTANGLEPROFILEDEF') {
    const position = entity(profile.attributes[2]);
    const centre = entity(position.attributes[0]).attributes[0] as number[];
    const direction = position.attributes[1] == null ? [1, 0] : entity(position.attributes[1]).attributes[0] as number[];
    const x = Number(profile.attributes[3]) / 2, y = Number(profile.attributes[4]) / 2;
    points = ([[-x, -y], [x, -y], [x, y], [-x, y]] as Point[]).map(([u, v]) =>
      [centre[0] + direction[0] * u - direction[1] * v, centre[1] + direction[1] * u + direction[0] * v]);
  } else {
    expect(profile.type.toUpperCase()).toBe('IFCARBITRARYCLOSEDPROFILEDEF');
    const curve = entity(profile.attributes[2]);
    points = (curve.attributes[0] as unknown[]).map(ref => entity(ref).attributes[0] as Point);
  }
  return points.map(xy => [frame(solid.attributes[1]), ...frames].reduce((p, apply) => apply(p), xy));
}

function contains(points: Point[], expected: Point): void {
  expect(Math.min(...points.map(p => Math.hypot(p[0] - expected[0], p[1] - expected[1])))).toBeLessThan(2e-8);
}

for (const fullGraph of [false, true]) for (const dy of [0, 1]) {
  it(`#9296 F6 moved imported corner has correct butt faces on BOTH walls; full graph=${fullGraph}, perpendicular=${dy}`, async t => {
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
    const result = editor.runAtomic(draft => transformElementsInStore({ dataStore, editor: draft, view: draft.getMutationView(), selected: [15042], op: { kind: 'move', delta: [dy ? 0 : 1, dy] } }));
    expect(result.remesh).toEqual(expect.arrayContaining([15042, 17040]));
    expect(readWallJoinTarget(dataStore, view, 17040, 1)?.wall.start).toEqual([7.41, 10]);
    expect(readWallJoinTarget(dataStore, view, 17040, 1)?.wall.end).toEqual([7.41, 4.25 + dy]);
    expect(readWallJoinTarget(dataStore, view, 15042, 1)?.location).toEqual([dy ? 7.41 : 8.41, 4.25 + dy, 0]);

    // The neighbour stays vertical at x=7.41. Its outer face is x=7.65;
    // the moved wall remains horizontal. Their common face has zero gap/overlap.
    const sharedTop: Point = [7.65, 4.25 + dy];
    const sharedBottom: Point = [7.65, 4.01 + dy];

    const check = (reader: AnchorEntityReader) => {
      const moved = polygon(reader, 15042), neighbour = polygon(reader, 17040);
      contains(moved, sharedTop); contains(moved, sharedBottom);
      // The neighbour extends/trims on its original axis to the moved face.
      contains(neighbour, sharedBottom);
      contains(neighbour, [7.41, 4.01 + dy]);
      if (!fullGraph) contains(neighbour, [7.41, 9.7]);
      expect(Math.min(...moved.map(p => p[0])) - 7.41).toBeCloseTo(.24, 8);
      for (const p of moved) expect(p[0] - 7.41).toBeGreaterThanOrEqual(.24 - 2e-8);
      for (const p of neighbour) expect(p[0] - 7.41).toBeLessThanOrEqual(.24 + 2e-8);
      // The far-end join stays at the stationary path wall rather than
      // disconnecting and making a square end beyond it.
      expect(Math.max(...moved.map(p => p[0]))).toBeCloseTo(fullGraph ? 11.7 : (dy ? 11.7 : 12.7), 8);
    };
    check(new AnchorEntityReader(dataStore, view));
    const rels = readWallJoinRels(dataStore, view, new Set([15042]));
    expect(rels).toHaveLength(fullGraph ? 2 : 1);
    expect(rels.find(r => r.relatingId === 17040)).toMatchObject({ relatingId: 17040, relatedId: 15042, relatingConnection: 'ATEND', relatedConnection: 'ATSTART' });

    // The asserted geometry must survive a real STEP export and independent reparse.
    const exported = new StepExporter(dataStore, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const reopened = await new IfcParser().parseColumnar(exported.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    check(new AnchorEntityReader(reopened));
  });
}
