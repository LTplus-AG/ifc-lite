/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { LineWeightAssigner } from './line-weights.js';
import type { DrawingLine } from '../types.js';

function drawingLine(overrides: Partial<DrawingLine>): DrawingLine {
  return {
    line: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
    category: 'projection',
    visibility: 'visible',
    entityId: 1,
    ifcType: 'IfcFurniture',
    modelIndex: 0,
    depth: 0,
    ...overrides,
  } as DrawingLine;
}

describe('LineWeightAssigner.assignWeight', () => {
  const assigner = new LineWeightAssigner();

  it('assigns hairline weight to a hidden-visibility projection line', () => {
    // visibility is 'hidden' but category is 'projection' (not 'hidden') -
    // the doc comment says "Hidden lines are always hairline", which should
    // trigger on visibility alone, not require category === 'hidden' too.
    const l = drawingLine({ visibility: 'hidden', category: 'projection' });
    const result = assigner.assignWeight(l);
    expect(result.lineWeight).toBe('hairline');
  });

  it('assigns hairline weight to a hidden-category line', () => {
    const l = drawingLine({ visibility: 'visible', category: 'hidden' });
    const result = assigner.assignWeight(l);
    expect(result.lineWeight).toBe('hairline');
  });

  it('does not force hairline for a visible projection line', () => {
    const l = drawingLine({ visibility: 'visible', category: 'projection' });
    const result = assigner.assignWeight(l);
    expect(result.lineWeight).not.toBe('hairline');
    expect(result.lineWeight).toBe('light');
  });
});
