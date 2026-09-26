/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

  it('distinguishes sheet PDF, which embeds visible underlays, from vector PDF and DXF', async () => {
    const content = { ...empty, visibleUnderlayCount: 2 };
    assert.deepEqual(await omissions(content, 'pdf'), ['underlays']);
    assert.deepEqual(await omissions({ ...content, sheetScale: 50 }, 'pdf'), []);
    assert.deepEqual(await omissions({
      ...content, sheetScale: 50, markupCounts: { ...empty.markupCounts, texts: 1 },
    }, 'pdf'), ['markups']);
    assert.deepEqual(await omissions({ ...content, sheetScale: 50 }, 'dxf'), ['underlays']);
  });

  it('names a requested scale only when a sheet overrides it', async () => {
    assert.deepEqual(await omissions({ ...empty, requestedScale: 100 }, 'pdf'), []);
    assert.deepEqual(await omissions({ ...empty, sheetScale: 50, requestedScale: 50 }, 'pdf'), []);
    assert.deepEqual(await omissions({ ...empty, sheetScale: 50, requestedScale: 100 }, 'pdf'), ['requestedScale']);
    assert.deepEqual(await omissions({ ...empty, sheetScale: 50, requestedScale: 100 }, 'dxf'), []);
  });
});
