/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcAxis2Placement3D.AxisAndRefDirProvision` (#5469): `Axis` and
 * `RefDirection` are both present or both absent. `IfcCreator` used to write a
 * wall's placement as `IFCAXIS2PLACEMENT3D(#o,$,#ref)`, which IfcOpenShell's
 * `express_rules=True` validation rejects. The schema-level oracle for this is
 * `ifcopenshell-ifc4x3-conformance.test.ts`; this file pins the invariant on
 * every placement-writing builder without needing Python.
 */

import { describe, expect, it } from 'vitest';
import { completePlacementAxes } from './ifc-creator-math.js';
import { IfcCreator } from './ifc-creator.js';
import type { Point3D } from './types.js';

function directions(content: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const m of content.matchAll(/^#(\d+)=IFCDIRECTION\(\(([^)]*)\)\);$/gm)) {
    out.set(`#${m[1]}`, m[2].split(',').map(Number));
  }
  return out;
}

/** Every IFCAXIS2PLACEMENT3D as its [Axis, RefDirection] tokens. */
function axisPairs(content: string): Array<[string, string]> {
  return [...content.matchAll(/^#\d+=IFCAXIS2PLACEMENT3D\(#\d+,([^,]+),([^)]+)\);$/gm)].map(
    (m): [string, string] => [m[1], m[2]],
  );
}

function expectClose(actual: number[] | Point3D | undefined, expected: number[]): void {
  expect(actual).toBeDefined();
  expected.forEach((v, i) => expect(actual![i]).toBeCloseTo(v, 9));
}

describe('completePlacementAxes (#5469)', () => {
  it('leaves an unrotated placement with neither direction', () => {
    expect(completePlacementAxes(undefined, undefined)).toBeUndefined();
  });

  it('keeps an explicit pair as given', () => {
    expect(completePlacementAxes([0, 1, 0], [1, 0, 0])).toEqual({ Axis: [0, 1, 0], RefDirection: [1, 0, 0] });
  });

  it('writes the default Axis (0,0,1) for a RefDirection-only placement', () => {
    expect(completePlacementAxes(undefined, [0, 1, 0])).toEqual({ Axis: [0, 0, 1], RefDirection: [0, 1, 0] });
  });

  it('writes IfcFirstProjAxis(Axis) for an Axis-only placement', () => {
    // World X projected onto the plane normal to a tilted Axis.
    const tilted = completePlacementAxes([1, 0, 1], undefined);
    expectClose(tilted?.RefDirection, [Math.SQRT1_2, 0, -Math.SQRT1_2]);
    // Axis along +Y: world X is already normal to it.
    expectClose(completePlacementAxes([0, 1, 0], undefined)?.RefDirection, [1, 0, 0]);
    // Axis along X: the schema switches to world Y.
    expectClose(completePlacementAxes([1, 0, 0], undefined)?.RefDirection, [0, 1, 0]);
    expectClose(completePlacementAxes([-1, 0, 0], undefined)?.RefDirection, [0, 1, 0]);
  });
});

describe('IfcCreator writes IfcAxis2Placement3D Axis and RefDirection both or neither (#5469)', () => {
  it('holds for every builder whose placement carries a rotation', () => {
    const creator = new IfcCreator({ Name: 'placement axes', Timestamp: 0 });
    const storey = creator.addIfcBuildingStorey({ Name: 'Level 0', Elevation: 0 });
    creator.addIfcWall(storey, { Start: [0, 0, 0], End: [0, 4, 0], Thickness: 0.2, Height: 3 });
    creator.addIfcStair(storey, {
      Position: [1, 1, 0], Direction: Math.PI / 2, NumberOfRisers: 3, RiserHeight: 0.18, TreadLength: 0.28, Width: 1,
    });
    creator.addIfcCurtainWall(storey, { Start: [0, 0, 0], End: [3, 3, 0], Height: 3 });
    creator.addIfcFurnishingElement(storey, { Position: [2, 2, 0], Width: 1, Depth: 1, Height: 1, Direction: 1 });
    creator.addIfcBeam(storey, { Start: [0, 0, 3], End: [5, 0, 3], Width: 0.2, Height: 0.4 });
    const content = creator.toIfc().content;

    const pairs = axisPairs(content);
    expect(pairs.length).toBeGreaterThan(5);
    for (const [axis, refDirection] of pairs) {
      expect(axis === '$', `IFCAXIS2PLACEMENT3D(...,${axis},${refDirection})`).toBe(refDirection === '$');
    }
  });

  it('keeps the wall frame: Axis +Z, RefDirection along the wall', () => {
    const creator = new IfcCreator({ Name: 'wall frame', Timestamp: 0 });
    const storey = creator.addIfcBuildingStorey({ Name: 'Level 0', Elevation: 0 });
    creator.addIfcWall(storey, { Start: [0, 0, 0], End: [0, 4, 0], Thickness: 0.2, Height: 3 });
    const content = creator.toIfc().content;
    const dirs = directions(content);
    // The wall's placement is the only one rotating to +Y.
    const wallPair = axisPairs(content).find(([, ref]) => ref !== '$' && dirs.get(ref)?.[1] === 1);
    expect(wallPair).toBeDefined();
    expect(dirs.get(wallPair![0])).toEqual([0, 0, 1]);
  });

  it('completes an Axis-only addLocalPlacement with the schema-implied RefDirection', () => {
    const creator = new IfcCreator({ Name: 'axis only', Timestamp: 0 });
    creator.addLocalPlacement(creator.getWorldPlacementId(), { Location: [0, 0, 0], Axis: [0, -1, 0] });
    const content = creator.toIfc().content;
    const dirs = directions(content);
    const pair = axisPairs(content).find(([axis]) => axis !== '$' && dirs.get(axis)?.[1] === -1);
    expect(pair).toBeDefined();
    expect(dirs.get(pair![1])).toEqual([1, 0, 0]);
  });
});
