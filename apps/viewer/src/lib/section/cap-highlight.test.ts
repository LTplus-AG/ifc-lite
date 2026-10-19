/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CAP_HOVER_COLOR, CAP_SELECTION_COLOR, sectionCapHighlight } from './cap-highlight.js';
import { capOverlayInput } from './cap-overlay.js';

const state = (over: Partial<Parameters<typeof sectionCapHighlight>[0]> = {}) => ({
  activeTool: 'section', hoverHighlightEnabled: true, hoverState: { entityId: null as number | null }, ...over,
});

describe('sectionCapHighlight (#7950)', () => {
  it('paints the selected element and every multi-selected one in the selection colour', () => {
    const map = sectionCapHighlight(state(), 5, new Set([6, 7]))!;
    assert.deepEqual([...map.keys()].sort(), ['*:5', '*:6', '*:7']);
    for (const c of map.values()) assert.deepEqual(c, CAP_SELECTION_COLOR);
  });

  it('paints the hovered element, but selection wins when it is also selected', () => {
    const map = sectionCapHighlight(state({ hoverState: { entityId: 9 } }), 5, undefined)!;
    assert.deepEqual(map.get('*:9'), CAP_HOVER_COLOR);
    const both = sectionCapHighlight(state({ hoverState: { entityId: 5 } }), 5, undefined)!;
    assert.deepEqual(both.get('*:5'), CAP_SELECTION_COLOR);
  });

  it('scopes selection and hover to their model', () => {
    const map = sectionCapHighlight(state({ hoverState: { entityId: 9, modelIndex: 2 } }), 5, undefined, 1)!;
    assert.deepEqual([...map.keys()].sort(), ['1:5', '2:9']);
  });

  it('ignores hover while hover highlight is off', () => {
    assert.equal(sectionCapHighlight(state({ hoverHighlightEnabled: false, hoverState: { entityId: 9 } }), null, undefined), null);
  });

  it('is null with nothing selected, and outside the section tool', () => {
    assert.equal(sectionCapHighlight(state(), null, new Set()), null);
    assert.equal(sectionCapHighlight(state({ activeTool: 'measure' }), 5, undefined), null);
  });
});

describe('capOverlayInput fill mode (#7950)', () => {
  const square = { outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], holes: [] };
  const cut = {
    cutPolygons: [
      { polygon: square, entityId: 1, ifcType: 'IfcWall', modelIndex: 0, isCut: true, sourceColor: [0.2, 0.4, 0.6, 0.5] as [number, number, number, number] },
      { polygon: square, entityId: 2, ifcType: 'IfcSlab', modelIndex: 0, isCut: true, color: [1, 0, 0, 0.5] as [number, number, number, number], sourceColor: [0, 1, 0, 1] as [number, number, number, number] },
      { polygon: square, entityId: 3, ifcType: 'IfcBeam', modelIndex: 0, isCut: true },
    ],
    layerBaseCutPolygons: [],
    lines: [],
  };

  it('uniform (default): single-material polygons carry no colour', () => {
    const { polygons } = capOverlayInput(cut, false);
    assert.equal(polygons[0].color, undefined);
    assert.deepEqual(polygons[1].color, [1, 0, 0, 0.5], 'uniform mode leaves layer colours as they were');
  });

  it('element: polygons keep their source colour, opaque; layer colour wins, also opaque; colourless stays uniform', () => {
    const { polygons } = capOverlayInput(cut, false, 'element');
    assert.deepEqual(polygons[0].color, [0.2, 0.4, 0.6, 1]);
    assert.deepEqual(polygons[1].color, [1, 0, 0, 1]);
    assert.equal(polygons[2].color, undefined);
  });

  it('carries modelIndex on base and layer polygons alike, so a model-scoped highlight reaches both', () => {
    const base = { polygon: square, entityId: 4, ifcType: 'IfcWall', modelIndex: 2, isCut: true };
    const { polygons } = capOverlayInput({ ...cut, cutPolygons: [{ ...base }], layerBaseCutPolygons: [base] }, false);
    assert.deepEqual(polygons.map((p) => p.modelIndex), [2, 2]);
  });
});
