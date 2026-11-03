/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The SVG export of a section through an open surface (#8664): the report's
 * symptom was `polygon-fills` holding the sheet and `drawing-lines` empty. Runs a
 * real generated drawing through the real `handleExportSVG`.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Drawing2DGenerator, createSectionConfig } from '@ifc-lite/drawing-2d';
import type { MeshData } from '@ifc-lite/geometry';
import { exportDrawingSvg } from '@/test/export-drawing-svg.js';

/** One folded sheet in y in [0, 3]; a plan cut used to fill the triangle under its chord. */
function foldedSheet(): MeshData {
  const positions = new Float32Array([
    0, 0, 0, 2, 0, 1, 2, 3, 1, 0, 3, 0,
    2, 0, 1, 4, 0, 0, 4, 3, 0, 2, 3, 1,
  ]);
  return {
    expressId: 44766,
    ifcType: 'IfcBuildingElementProxy',
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
    color: [0.5, 0.5, 0.5, 1],
  };
}

describe('useDrawingExport SVG writer: section of an open surface (#8664)', () => {
  it('writes the cut under drawing-lines, with nothing under polygon-fills', async () => {
    const drawing = await new Drawing2DGenerator().generate([foldedSheet()], createSectionConfig('y', 1.5), {
      useGPU: false,
      mergeLines: true,
      includeProjection: false,
      includeEdges: false,
      includeHiddenLines: false,
    });
    const svg = new DOMParser().parseFromString(await exportDrawingSvg(drawing), 'image/svg+xml');
    assert.equal(svg.querySelectorAll('#polygon-fills path').length, 0);
    assert.equal(svg.querySelectorAll('#drawing-lines line').length, 2);
  });
});
