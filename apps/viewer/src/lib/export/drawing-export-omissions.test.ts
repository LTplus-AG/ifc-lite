/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dimensionGraphics } from '@/lib/drawing2d-markup/dimension-graphics';
import type { DrawingExportContent, DrawingExportFormat } from './drawing-export-omissions';

async function omissions(content: DrawingExportContent, format: DrawingExportFormat) {
  // Load inside the test so the revert oracle can observe a missing feature
  // as an assertion, while branch runs still exercise the pure implementation.
  const module = await import('./drawing-export-omissions.js').catch(() => null);
  assert.ok(module, 'the drawing omission detector must exist');
  return module.drawingExportOmissions(content, format);
}

const empty: DrawingExportContent = {
  markupCounts: { measurements: 0, areas: 0, texts: 0, clouds: 0 },
  visibleUnderlayCount: 0,
  sheetScale: null,
};

const graphic = (length = 5, paperScale = 100) => dimensionGraphics({
  id: 'test', a: { x: 0, y: 0 }, b: { x: length, y: 0 }, offset: 0, orientation: 'aligned',
}, { paperScale, format: m => `${m} m` });

describe('drawing export omissions (#5850)', () => {
  it('reports nothing when the drawing has no omitted content', async () => {
    assert.deepEqual(await omissions(empty, 'pdf'), []);
    assert.deepEqual(await omissions(empty, 'dxf'), []);
  });

  it('reports every markup kind for the PDF and DXF writers', async () => {
    for (const kind of ['measurements', 'areas', 'texts', 'clouds'] as const) {
      const content = { ...empty, markupCounts: { ...empty.markupCounts, [kind]: 1 } };
      assert.deepEqual(await omissions(content, 'pdf'), ['markups'], kind);
      assert.deepEqual(await omissions(content, 'dxf'), ['markups'], kind);
    }
  });

  it('names dimensions only when some were drawn on another cut; those on the current cut export everywhere', async () => {
    // Dimensions on the current cut are not a markup kind the writers omit, so
    // with none from another cut there is nothing to warn about.
    assert.deepEqual(await omissions({ ...empty, otherCutDimensionCount: 0 }, 'pdf'), []);
    assert.deepEqual(await omissions({ ...empty, otherCutDimensionCount: 0 }, 'dxf'), []);
    for (const format of ['pdf', 'dxf'] as const) {
      assert.deepEqual(await omissions({ ...empty, otherCutDimensionCount: 2 }, format), ['otherCutDimensions'], format);
      assert.deepEqual(await omissions({
        ...empty, otherCutDimensionCount: 1, markupCounts: { ...empty.markupCounts, clouds: 1 },
      }, format), ['markups', 'otherCutDimensions'], format);
      assert.deepEqual(await omissions({ ...empty, otherCutDimensionCount: 1, sheetScale: 50 }, format), ['otherCutDimensions'], `${format} sheet`);
    }
  });

  it('warns before DXF drops a placed zero-length Distance measurement (#10020)', async () => {
    const content = {
      ...empty,
      markupCounts: { ...empty.markupCounts, measurements: 1 },
      dimensionGraphics: [graphic(0)],
    };
    assert.deepEqual(await omissions(content, 'dxf'), ['markups']);
  });

  it('includes vectors in every format and omits only eligible raster references from DXF (#6615)', async () => {
    const content = { ...empty, visibleUnderlayCount: 2 };
    assert.deepEqual(await omissions(content, 'pdf'), []);
    assert.deepEqual(await omissions({ ...content, sheetScale: 50 }, 'pdf'), []);
    assert.deepEqual(await omissions({
      ...content, sheetScale: 50, markupCounts: { ...empty.markupCounts, texts: 1 },
    }, 'pdf'), ['markups']);
    assert.deepEqual(await omissions({ ...content, sheetScale: 50 }, 'dxf'), []);
    const raster = { ...content, visibleRasterReferenceCount: 1 };
    assert.deepEqual(await omissions(raster, 'dxf'), ['rasterReferences']);
    assert.deepEqual(await omissions(raster, 'pdf'), []);
    assert.deepEqual(await omissions({ ...raster, sheetScale: 50 }, 'pdf'), []);
    assert.deepEqual(await omissions({ ...raster, visibleRasterReferenceCount: 0 }, 'dxf'), []);
  });

  it('names a requested scale only when a sheet overrides it', async () => {
    assert.deepEqual(await omissions({ ...empty, requestedScale: 100 }, 'pdf'), []);
    assert.deepEqual(await omissions({ ...empty, sheetScale: 50, requestedScale: 50 }, 'pdf'), []);
    assert.deepEqual(await omissions({ ...empty, sheetScale: 50, requestedScale: 100 }, 'pdf'), ['requestedScale']);
    assert.deepEqual(await omissions({ ...empty, sheetScale: 50, requestedScale: 100 }, 'dxf'), []);
  });
  it('still names markups for a caller that passes counts without dimensions', async () => {
    const legacy = { ...empty, markupCounts: { measurements: 1, areas: 0, texts: 0, clouds: 0 } };
    assert.deepEqual(await omissions(legacy, 'pdf'), ['markups']);
  });
  it('ignores a current-cut dimension count passed with the other markup counts', async () => {
    const counted = { ...empty, markupCounts: { ...empty.markupCounts, dimensions: 3 }, dimensionGraphics: [graphic(), graphic(), graphic()] };
    assert.deepEqual(await omissions(counted, 'pdf'), []);
    assert.deepEqual(await omissions(counted, 'dxf'), []);
  });
  it('uses one rule for Distance and linear dimensions without counting other-cut omissions twice (#10020, #10077)', async () => {
    const content = { ...empty, markupCounts: { ...empty.markupCounts, measurements: 1, dimensions: 2 },
      otherCutDimensionCount: 1, dimensionGraphics: [graphic(5), graphic(2)] };
    for (const format of ['pdf', 'dxf'] as const) {
      assert.deepEqual(await omissions(content, format), ['otherCutDimensions']);
      assert.deepEqual(await omissions({ ...content, dimensionGraphics: [graphic(0), graphic(2)] }, format), ['markups', 'otherCutDimensions']);
      assert.deepEqual(await omissions({ ...content, dimensionGraphics: [graphic(5, 0), graphic(2, 0)] }, format), ['markups', 'otherCutDimensions']);
    }
  });

  it('other-cut counts cannot hide missing Distance details in a legacy caller (#10020)', async () => {
    const content = { ...empty, markupCounts: { ...empty.markupCounts, measurements: 1 }, otherCutDimensionCount: 1 };
    for (const format of ['pdf', 'dxf'] as const) {
      assert.deepEqual(await omissions(content, format), ['markups', 'otherCutDimensions']);
    }
  });

  it('SVG and Print report rejected dimensions, while keeping the ordinary markups they support (#10020)', async () => {
    const content = { ...empty, markupCounts: { ...empty.markupCounts, measurements: 1, areas: 1, texts: 1, clouds: 1 },
      dimensionGraphics: [graphic()] };
    for (const format of ['svg', 'print'] as const) {
      assert.deepEqual(await omissions(content, format), []);
      assert.deepEqual(await omissions({ ...content, sheetScale: 50 }, format), ['markups']);
      assert.deepEqual(await omissions({ ...content, dimensionGraphics: [graphic(0)] }, format), ['markups']);
      // #10167 supplies the single counted other-cut toast after successful output.
      assert.deepEqual(await omissions({ ...content, otherCutDimensionCount: 1 }, format), []);
      assert.deepEqual(await omissions({ ...content, otherCutDimensionCount: 1, dimensionGraphics: [graphic(0)] }, format), ['markups']);
    }
  });

});
