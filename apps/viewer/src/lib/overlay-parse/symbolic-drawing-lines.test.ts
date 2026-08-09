/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { SymbolicRepresentationCollection } from '@ifc-lite/wasm';
import { collectFlatSymbolic } from './symbolic-flat.js';
import {
  buildSymbolicDrawingLines,
  type SymbolicDrawingLine,
} from './symbolic-drawing-lines.js';

/**
 * Equivalence anchor for moving the 2D drawing's symbolic walk into the
 * overlay worker (#2183).
 *
 * `useDrawingGeneration` used to walk the WASM collection inline on the main
 * thread, which regrew a ~470 MB `WebAssembly.Memory` there the first time a
 * user generated a drawing. The walk now runs over the worker's flat arrays
 * instead — and "the plan still looks right" is not a proof: a dropped closing
 * segment, a sign flip on the recovered world Z, or a lost `entitiesWithSymbols`
 * entry all silently change which section-cut lines get replaced by symbols.
 *
 * So this pins the new implementation against a VERBATIM copy of the walk that
 * was deleted, run over the same fake collection. The two are independent
 * implementations; only real agreement passes.
 *
 * Every scalar the fake hands out is `Math.fround`ed and the points are a
 * `Float32Array`, because that is what a wasm-bindgen getter returns: f32
 * values widened to JS numbers. Feeding the legacy walk f64s it could never
 * have seen would make it disagree with the (necessarily f32) flatten for
 * reasons that have nothing to do with this change.
 */

const f32 = Math.fround;

interface FakePoly {
  ifcType: string;
  expressId: number;
  worldY: number;
  isClosed: boolean;
  points: Float32Array;
  pointCount: number;
  free(): void;
}

interface FakeCircle {
  ifcType: string;
  expressId: number;
  worldY: number;
  isFullCircle: boolean;
  centerX: number;
  centerY: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  free(): void;
}

function poly(
  ifcType: string,
  expressId: number,
  worldY: number,
  points: number[],
  isClosed = false,
): FakePoly {
  return {
    ifcType,
    expressId,
    worldY: f32(worldY),
    isClosed,
    points: Float32Array.from(points),
    pointCount: points.length / 2,
    free() { /* handle release is covered by symbolic-flat.test.ts */ },
  };
}

function circle(
  ifcType: string,
  expressId: number,
  worldY: number,
  fields: {
    centerX: number;
    centerY: number;
    radius: number;
    startAngle: number;
    endAngle: number;
    isFullCircle: boolean;
  },
): FakeCircle {
  return {
    ifcType,
    expressId,
    worldY: f32(worldY),
    isFullCircle: fields.isFullCircle,
    centerX: f32(fields.centerX),
    centerY: f32(fields.centerY),
    radius: f32(fields.radius),
    startAngle: f32(fields.startAngle),
    endAngle: f32(fields.endAngle),
    free() { /* handle release is covered by symbolic-flat.test.ts */ },
  };
}

function makeCollection(items: {
  polylines?: FakePoly[];
  circles?: FakeCircle[];
}): SymbolicRepresentationCollection {
  const polylines = items.polylines ?? [];
  const circles = items.circles ?? [];
  return {
    polylineCount: polylines.length,
    circleCount: circles.length,
    textCount: 0,
    fillCount: 0,
    getPolyline: (i: number) => polylines[i],
    getCircle: (i: number) => circles[i],
    getText: () => undefined,
    getFill: () => undefined,
  } as unknown as SymbolicRepresentationCollection;
}

/**
 * The walk exactly as it stood in `useDrawingGeneration.ts` before #2183's
 * step 2 — handle reads, 32/16-segment arcs, centroids and all. Do not
 * "improve" it: its value is that it is the shipped behaviour.
 */
function legacyWalk(collection: SymbolicRepresentationCollection): {
  lines: SymbolicDrawingLine[];
  entities: Set<number>;
} {
  const symbolicLines: SymbolicDrawingLine[] = [];
  const entitiesWithSymbols = new Set<number>();
  const symbolicModelIndex = 0;
  const c = collection as unknown as {
    polylineCount: number;
    circleCount: number;
    getPolyline(i: number): FakePoly | undefined;
    getCircle(i: number): FakeCircle | undefined;
  };

  for (let i = 0; i < c.polylineCount; i++) {
    const p = c.getPolyline(i);
    if (!p) continue;
    entitiesWithSymbols.add(p.expressId);
    const points = p.points;
    const pointCount = p.pointCount;
    const polyWorldY = (p as unknown as { worldY?: number }).worldY;
    let sumX = 0;
    let sumY = 0;
    for (let q = 0; q < pointCount; q++) {
      sumX += points[q * 2];
      sumY += points[q * 2 + 1];
    }
    const polyWorldX = pointCount > 0 ? sumX / pointCount : undefined;
    const polyWorldZ = pointCount > 0 ? -sumY / pointCount : undefined;

    for (let j = 0; j < pointCount - 1; j++) {
      symbolicLines.push({
        line: {
          start: { x: points[j * 2], y: points[j * 2 + 1] },
          end: { x: points[(j + 1) * 2], y: points[(j + 1) * 2 + 1] },
        },
        category: 'silhouette',
        visibility: 'visible',
        entityId: p.expressId,
        ifcType: p.ifcType,
        modelIndex: symbolicModelIndex,
        depth: 0,
        worldX: polyWorldX,
        worldY: polyWorldY,
        worldZ: polyWorldZ,
      });
    }

    if (p.isClosed && pointCount > 2) {
      symbolicLines.push({
        line: {
          start: { x: points[(pointCount - 1) * 2], y: points[(pointCount - 1) * 2 + 1] },
          end: { x: points[0], y: points[1] },
        },
        category: 'silhouette',
        visibility: 'visible',
        entityId: p.expressId,
        ifcType: p.ifcType,
        modelIndex: symbolicModelIndex,
        depth: 0,
        worldX: polyWorldX,
        worldY: polyWorldY,
        worldZ: polyWorldZ,
      });
    }
  }

  for (let i = 0; i < c.circleCount; i++) {
    const cir = c.getCircle(i);
    if (!cir) continue;
    entitiesWithSymbols.add(cir.expressId);
    const numSegments = cir.isFullCircle ? 32 : 16;
    const circleWorldY = (cir as unknown as { worldY?: number }).worldY;
    const circleWorldX = cir.centerX;
    const circleWorldZ = -cir.centerY;

    for (let j = 0; j < numSegments; j++) {
      const t1 = j / numSegments;
      const t2 = (j + 1) / numSegments;
      const a1 = cir.startAngle + t1 * (cir.endAngle - cir.startAngle);
      const a2 = cir.startAngle + t2 * (cir.endAngle - cir.startAngle);
      symbolicLines.push({
        line: {
          start: {
            x: cir.centerX + cir.radius * Math.cos(a1),
            y: cir.centerY + cir.radius * Math.sin(a1),
          },
          end: {
            x: cir.centerX + cir.radius * Math.cos(a2),
            y: cir.centerY + cir.radius * Math.sin(a2),
          },
        },
        category: 'silhouette',
        visibility: 'visible',
        entityId: cir.expressId,
        ifcType: cir.ifcType,
        modelIndex: symbolicModelIndex,
        depth: 0,
        worldX: circleWorldX,
        worldY: circleWorldY,
        worldZ: circleWorldZ,
      });
    }
  }

  return { lines: symbolicLines, entities: entitiesWithSymbols };
}

/** Mixed set: closed + open + degenerate polylines, a full circle and an arc. */
function fixture(): SymbolicRepresentationCollection {
  return makeCollection({
    polylines: [
      // Non-annotation types must survive: the drawing draws every product's
      // plan representation, which is why it asks the flatten for 'all'.
      poly('IfcWall', 101, 2.5, [0, 0, 4, 0, 4, 3, 0, 3], true),
      poly('IfcAnnotation', 102, 0, [1, 1, 2, 2]),
      poly('IfcDoor', 103, 2.5, [0.5, 0.5, 1.5, 0.5, 1.5, 1.5]),
      // Closed but only 2 points: no closing segment (pointCount > 2 fails).
      poly('IfcSlab', 104, -1.25, [0, 0, 1, 0], true),
      // No points at all: contributes an entity id and nothing else.
      poly('IfcGridAxis', 105, 3, []),
    ],
    circles: [
      circle('IfcGridAxis', 201, 3, {
        centerX: 2.5, centerY: -1.5, radius: 0.75,
        startAngle: 0, endAngle: Math.PI * 2, isFullCircle: true,
      }),
      circle('IfcAnnotation', 202, 0.5, {
        centerX: -4, centerY: 8.25, radius: 1.5,
        startAngle: Math.PI / 4, endAngle: Math.PI, isFullCircle: false,
      }),
    ],
  });
}

describe('buildSymbolicDrawingLines (#2183)', () => {
  it('reproduces the deleted main-thread walk exactly', () => {
    const flat = collectFlatSymbolic(fixture(), 'all');
    const viaWorker = buildSymbolicDrawingLines(structuredClone(flat), 0);
    const legacy = legacyWalk(fixture());

    assert.deepStrictEqual(viaWorker.lines, legacy.lines);
    assert.deepStrictEqual([...viaWorker.entities].sort(), [...legacy.entities].sort());
    // Guard against a vacuous pass: a filter that dropped everything, or a
    // flatten that never ran, would satisfy deepStrictEqual on two empties.
    assert.equal(
      legacy.lines.length,
      // 101: 3 segments + its closing one. 102: 1. 103: 2. 104: 1 (closed, but
      // 2 points, so no closing segment). 105: none. Then 32 + 16 arc segments.
      (3 + 1) + 1 + 2 + 1 + 32 + 16,
    );
    assert.deepStrictEqual([...legacy.entities].sort(), [101, 102, 103, 104, 105, 201, 202]);
  });

  it('carries the owner type through, non-annotation types included', () => {
    const { lines } = buildSymbolicDrawingLines(collectFlatSymbolic(fixture(), 'all'));
    const types = new Set(lines.map((l) => l.ifcType));
    assert.deepStrictEqual(
      [...types].sort(),
      ['IfcAnnotation', 'IfcDoor', 'IfcGridAxis', 'IfcSlab', 'IfcWall'],
    );
  });

  // The section cull reads these three; `worldZ` is the negated 2D y, and an
  // unresolvable elevation must stay `undefined` so the cull keeps the line
  // rather than testing NaN and dropping it.
  it('recovers the world-space centroid, and leaves an unknown elevation undefined', () => {
    const flat = collectFlatSymbolic(
      makeCollection({ polylines: [poly('IfcWall', 301, 0, [0, 0, 4, 2])] }),
      'all',
    );
    flat.polyWorldY[0] = Number.NaN; // what an absent wasm `worldY` flattens to
    const [line] = buildSymbolicDrawingLines(flat).lines;
    assert.equal(line.worldX, 2);
    assert.equal(line.worldZ, -1);
    assert.equal(line.worldY, undefined);
  });
});
