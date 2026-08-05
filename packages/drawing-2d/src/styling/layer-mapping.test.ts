/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { LayerMapper } from './layer-mapping.js';
import type { ArchitecturalLine } from '../types.js';

function line(overrides: Partial<ArchitecturalLine>): ArchitecturalLine {
  return {
    line: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
    category: 'cut',
    entityId: 1,
    ifcType: 'IfcWall',
    modelIndex: 0,
    depth: 0,
    semanticType: 'wall-cut',
    lineWeight: 'heavy',
    lineStyle: 'solid',
    visibility: 'visible',
    ...overrides,
  } as ArchitecturalLine;
}

describe('LayerMapper.getLayerForLine', () => {
  const mapper = new LayerMapper();

  it('routes a hidden-visibility line to the hidden layer even when solid', () => {
    const l = line({ visibility: 'hidden', lineStyle: 'solid' });
    const layer = mapper.getLayerForLine(l);
    expect(layer.aiaCode).toBe('A-HIDN');
  });

  it('routes a dashed line to the hidden layer even when visibility is visible', () => {
    const l = line({ visibility: 'visible', lineStyle: 'dashed' });
    const layer = mapper.getLayerForLine(l);
    expect(layer.aiaCode).toBe('A-HIDN');
  });

  it('does not route a visible solid wall-cut line to the hidden layer', () => {
    const l = line({ visibility: 'visible', lineStyle: 'solid' });
    const layer = mapper.getLayerForLine(l);
    expect(layer.aiaCode).not.toBe('A-HIDN');
    expect(layer.aiaCode).toBe('A-WALL');
  });
});
