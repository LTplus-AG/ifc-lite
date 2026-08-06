/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { SymbolicRepresentationCollection } from '@ifc-lite/wasm';
import { collectFlatSymbolic } from './symbolic-flat.js';
import { buildParseResult } from './symbolic-parse.js';

/**
 * Unit cover for the WASM→worker seam (#2183). The golden-digest test proves
 * the composed parse still produces byte-identical output; this proves the
 * three things that test cannot reach with real fixtures:
 *
 *   1. the type filter moved into the flatten drops exactly what the old
 *      main-side walk dropped,
 *   2. every handle is freed even when the walk throws mid-item, and
 *   3. the flat struct survives a structured clone, so running it in a worker
 *      does not change the assembled ParseResult (NaN sentinel included).
 */

interface FreeTracked {
  freed: boolean;
  free(): void;
}

function tracked<T extends object>(fields: T): T & FreeTracked {
  return {
    ...fields,
    freed: false,
    free(this: FreeTracked) {
      this.freed = true;
    },
  };
}

function poly(ifcType: string, expressId: number, worldY: number, points: number[]) {
  return tracked({
    ifcType,
    expressId,
    worldY,
    isClosed: false,
    points: Float32Array.from(points),
    pointCount: points.length / 2,
  });
}

function fill(ifcType: string, expressId: number, worldY: number, angleSecondary: number) {
  return tracked({
    ifcType,
    expressId,
    worldY,
    points: Float32Array.from([0, 0, 1, 0, 1, 1]),
    holesOffsets: Uint32Array.from([3]),
    fillR: 0.25,
    fillG: 0.5,
    fillB: 0.75,
    fillA: 1,
    hasHatching: true,
    hatchSpacing: 0.1,
    hatchAngle: 0.7853981633974483,
    hatchAngleSecondary: angleSecondary,
    hatchLineWidth: 0.002,
  });
}

/** Minimal stand-in for the wasm-bindgen collection handle. */
function makeCollection(items: {
  polylines?: unknown[];
  circles?: unknown[];
  texts?: unknown[];
  fills?: unknown[];
}): SymbolicRepresentationCollection {
  const polylines = items.polylines ?? [];
  const circles = items.circles ?? [];
  const texts = items.texts ?? [];
  const fills = items.fills ?? [];
  return {
    polylineCount: polylines.length,
    circleCount: circles.length,
    textCount: texts.length,
    fillCount: fills.length,
    getPolyline: (i: number) => polylines[i],
    getCircle: (i: number) => circles[i],
    getText: (i: number) => texts[i],
    getFill: (i: number) => fills[i],
  } as unknown as SymbolicRepresentationCollection;
}

describe('collectFlatSymbolic', () => {
  it('keeps only IfcAnnotation / IfcGridAxis, and frees every handle it took', () => {
    const kept = poly('IfcAnnotation', 11, 3, [0, 0, 1, 1]);
    const dropped = poly('IfcWall', 12, 3, [0, 0, 2, 2]);
    const grid = poly('IfcGridAxis', 13, 3, [0, 0, 3, 3]);

    const flat = collectFlatSymbolic(makeCollection({ polylines: [kept, dropped, grid] }));

    assert.deepStrictEqual([...flat.polyOwner], [11, 13]);
    assert.deepStrictEqual([...flat.polyPoints], [0, 0, 1, 1, 0, 0, 3, 3]);
    assert.deepStrictEqual([...flat.polyStart], [0, 2, 4]);
    assert.deepStrictEqual(
      [...flat.polyType].map((t) => flat.typeNames[t]),
      ['IfcAnnotation', 'IfcGridAxis'],
    );
    // The filtered-out handle is still fetched, so it must still be freed.
    for (const handle of [kept, dropped, grid]) assert.strictEqual(handle.freed, true);
  });

  it('frees the in-hand handle when the walk throws mid-item', () => {
    const ok = poly('IfcAnnotation', 21, 3, [0, 0, 1, 1]);
    // Built literally rather than through `tracked`, whose spread would
    // trigger the throwing getter at construction time.
    const exploding = {
      ifcType: 'IfcAnnotation',
      expressId: 22,
      isClosed: false,
      points: Float32Array.from([0, 0]),
      pointCount: 1,
      freed: false,
      get worldY(): number {
        throw new Error('wasm getter blew up');
      },
      free(this: FreeTracked) {
        this.freed = true;
      },
    };

    assert.throws(
      () => collectFlatSymbolic(makeCollection({ polylines: [ok, exploding] })),
      /wasm getter blew up/,
    );
    assert.strictEqual(ok.freed, true);
    assert.strictEqual(exploding.freed, true);
  });

  it('survives a structured clone: same ParseResult either side of the boundary', () => {
    const flat = collectFlatSymbolic(
      makeCollection({
        polylines: [poly('IfcAnnotation', 31, 3.5, [0, 0, 1, 1, 2, 0])],
        fills: [
          // NaN secondary angle = "no cross-hatch"; must still become null.
          fill('IfcAnnotation', 32, 3.5, Number.NaN),
          fill('IfcGridAxis', 33, 0, 1.25),
        ],
      }),
    );

    const hierarchy = { storeyElevations: new Map([[9, 7]]), elementToStorey: new Map([[33, 9]]) };
    const direct = buildParseResult(flat, hierarchy);
    const viaWorker = buildParseResult(structuredClone(flat), hierarchy);

    assert.deepStrictEqual(viaWorker, direct);
    // `assert.equal` is loose, so `undefined == null` — reach the hatching
    // explicitly first, or a missing bucket would pass the null assertion.
    const annotationHatch = direct.byStorey.get(3500)?.fills[0]?.hatching;
    assert.ok(annotationHatch, 'annotation fill bucketed at worldY 3.5');
    assert.strictEqual(annotationHatch.angleSecondary, null);
    // worldY 0 falls back to the storey table (elevation 7 → bucket key 7000).
    const gridHatch = direct.gridByStorey.get(7000)?.fills[0]?.hatching;
    assert.ok(gridHatch, 'grid fill bucketed via the storey-elevation fallback');
    assert.strictEqual(gridHatch.angleSecondary, 1.25);
  });
});
