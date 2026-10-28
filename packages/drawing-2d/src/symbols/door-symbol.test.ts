/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { DoorSymbolGenerator } from './door-symbol.js';
import type { DoorSwingParameters, OpeningInfo, Point2D } from '../types.js';

describe('DoorSymbolGenerator.generateSymbol (single swing)', () => {
  const generator = new DoorSymbolGenerator();
  const center = { x: 10, y: 0 };
  const width = 2;
  const wallDir = { x: 1, y: 0 };
  const swingDir = { x: 0, y: 1 };

  it('places the hinge on the -wallDir side of center for a left-hinged door', () => {
    const result = generator.generateSymbol(center, width, 'SINGLE_SWING_LEFT', wallDir, swingDir);
    const params = result.symbol.parameters as DoorSwingParameters;
    // hingeOffset = -halfWidth along wallDir => hinge x < center.x
    expect(params.hingePoint.x).toBeLessThan(center.x);
  });

  it('places the hinge on the +wallDir side of center for a right-hinged door', () => {
    const result = generator.generateSymbol(center, width, 'SINGLE_SWING_RIGHT', wallDir, swingDir);
    const params = result.symbol.parameters as DoorSwingParameters;
    expect(params.hingePoint.x).toBeGreaterThan(center.x);
  });
});

describe('DoorSymbolGenerator: swing arc must agree with the leaf line', () => {
  // A door symbol's swing arc traces the path of the leaf's free (non-hinge) tip as it
  // rotates from closed (flat against the wall) to open. Therefore the arc MUST end exactly
  // where the leaf line ends — anything else means the drawing shows the leaf swinging into
  // a different room than the arc.
  //
  // wallDir and swingDir are deliberately non-axis-aligned, and each has two non-zero
  // components, so a swapped x/y basis (or a sign flip on only one axis) cannot hide behind
  // a coincidental zero component the way an axis-aligned fixture would.
  const generator = new DoorSymbolGenerator();
  const center = { x: 10, y: 5 };
  const width = 2;
  const halfWidth = width / 2;
  // wallDir is a unit vector along (3, 4); swingDir is wallDir rotated +90 degrees (CCW),
  // matching DoorSymbolGenerator.getPerpendicularDirection / generateFromOpening's convention.
  const wallDir = { x: 0.6, y: 0.8 };
  const swingDir = { x: -0.8, y: 0.6 };

  function expectPointCloseTo(actual: { x: number; y: number }, expected: { x: number; y: number }) {
    expect(actual.x).toBeCloseTo(expected.x, 9);
    expect(actual.y).toBeCloseTo(expected.y, 9);
  }

  it.each([
    ['SINGLE_SWING_LEFT', 'left'],
    ['SINGLE_SWING_RIGHT', 'right'],
    ['DOUBLE_SWING_LEFT', 'left'],
    ['DOUBLE_SWING_RIGHT', 'right'],
  ] as const)('%s: arc end and leaf tip coincide, arc start is the opposite jamb', (operation, hingeSide) => {
    const result = generator.generateSymbol(center, width, operation, wallDir, swingDir);

    const hingeOffset = hingeSide === 'left' ? -halfWidth : halfWidth;
    const expectedHinge = {
      x: center.x + wallDir.x * hingeOffset,
      y: center.y + wallDir.y * hingeOffset,
    };
    const expectedLeafEnd = {
      x: expectedHinge.x + swingDir.x * width,
      y: expectedHinge.y + swingDir.y * width,
    };
    // Closed position: the leaf lies flat along the wall, reaching the opposite jamb.
    const expectedArcStart = {
      x: expectedHinge.x + wallDir.x * (hingeSide === 'left' ? width : -width),
      y: expectedHinge.y + wallDir.y * (hingeSide === 'left' ? width : -width),
    };

    const params = result.symbol.parameters as DoorSwingParameters;
    expectPointCloseTo(params.hingePoint, expectedHinge);

    const leaf = result.lines[0];
    expectPointCloseTo(leaf.start, expectedHinge);
    expectPointCloseTo(leaf.end, expectedLeafEnd);

    const arcSegments = generator['config'].arcSegments as number;
    const arcFirst = result.lines[1];
    const arcLast = result.lines[arcSegments];

    expectPointCloseTo(arcFirst.start, expectedArcStart);
    // The critical assertion: the arc's open end must coincide with the leaf's open tip.
    expectPointCloseTo(arcLast.end, expectedLeafEnd);

    // The SVG arc path must agree too: it also has to end at the leaf tip.
    expect(result.arcPath).toBeDefined();
    const match = result.arcPath?.match(
      /^M\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+A\s+[\d.eE+-]+\s+[\d.eE+-]+\s+0\s+\d\s+\d\s+([\d.eE+-]+)\s+([\d.eE+-]+)$/
    );
    expect(match).not.toBeNull();
    if (match) {
      const svgStart = { x: parseFloat(match[1]), y: parseFloat(match[2]) };
      const svgEnd = { x: parseFloat(match[3]), y: parseFloat(match[4]) };
      expectPointCloseTo(svgStart, expectedArcStart);
      expectPointCloseTo(svgEnd, expectedLeafEnd);
    }
  });
});

// #8232: hinge side from the door's own frame (IFC4.3 IfcDoorTypeOperationEnum: LEFT hinges on
// local -X seen along +Y; the leaf opens to +Y), so a mirrored placement flips the hand.
describe('DoorSymbolGenerator.generateFromOpening with the door frame (#8232)', () => {
  const generator = new DoorSymbolGenerator();
  const bounds = { min: { x: 9, y: -0.1 }, max: { x: 11, y: 0.1 } };
  const opening = (doorOperation: 'SINGLE_SWING_LEFT' | 'SINGLE_SWING_RIGHT') =>
    ({ type: 'door', openingId: 1, hostElementId: 2, width: 2, height: 2.1, doorOperation }) as unknown as OpeningInfo;
  const X = { x: 1, y: 0 };
  const Y = { x: 0, y: 1 };
  const hinge = (op: 'SINGLE_SWING_LEFT' | 'SINGLE_SWING_RIGHT', x: Point2D, y: Point2D) => {
    const r = generator.generateFromOpening(opening(op), bounds, X, { x, y });
    const lines = r.lines;
    const p = r.symbol.parameters as DoorSwingParameters;
    // leaf is lines[0]: hinge -> tip; the tip must agree with the arc's last point.
    const tip = lines[0].end;
    const arcEnd = lines[lines.length - 1].end;
    return { hinge: p.hingePoint, tip, arcEnd, arcStart: lines[1].start };
  };

  it('right-handed frame: LEFT hinges on -X, RIGHT on +X, both swing to +Y', () => {
    expect(hinge('SINGLE_SWING_LEFT', X, Y).hinge.x).toBeCloseTo(9);
    expect(hinge('SINGLE_SWING_RIGHT', X, Y).hinge.x).toBeCloseTo(11);
    expect(hinge('SINGLE_SWING_LEFT', X, Y).tip.y).toBeGreaterThan(0);
  });

  it('mirrored frame (X reversed, negative determinant) flips the hand', () => {
    const mirrored = { x: -1, y: 0 };
    expect(hinge('SINGLE_SWING_LEFT', mirrored, Y).hinge.x).toBeCloseTo(11);
    expect(hinge('SINGLE_SWING_RIGHT', mirrored, Y).hinge.x).toBeCloseTo(9);
  });

  it('mirrored frame (Y reversed) swings to -Y, with the arc still closing on the leaf tip and the opposite jamb', () => {
    const r = hinge('SINGLE_SWING_LEFT', X, { x: 0, y: -1 });
    expect(r.tip.y).toBeLessThan(0);
    expect(r.arcEnd.x).toBeCloseTo(r.tip.x, 9);
    expect(r.arcEnd.y).toBeCloseTo(r.tip.y, 9);
    expect(r.arcStart.x).toBeCloseTo(11, 9); // closed leaf lies along the wall to the far jamb
    expect(r.arcStart.y).toBeCloseTo(0, 9);
  });

  it('without a frame it keeps using wallDirection', () => {
    const r = generator.generateFromOpening(opening('SINGLE_SWING_RIGHT'), bounds, X);
    expect((r.symbol.parameters as DoorSwingParameters).hingePoint.x).toBeCloseTo(11);
  });
});
