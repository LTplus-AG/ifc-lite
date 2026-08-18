/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { DoorSymbolGenerator } from './door-symbol.js';
import type { DoorSwingParameters } from '../types.js';

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
