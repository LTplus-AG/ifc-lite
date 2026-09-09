/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppearanceAssetInventory } from '../assets.js';
import { PdfAppearanceSource } from './source-document.js';
import { controlledPdf } from './fixtures.js';
import type { PdfWorkerClient } from './worker-client.js';
import type { PdfJobResult, PdfRasterRecipe } from './types.js';
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const page = {
  pageNumber: 1,
  viewBox: [0, 0, 72, 72] as [number, number, number, number],
  userUnit: 1,
  intrinsicRotation: 0,
  widthPoints: 72,
  heightPoints: 72,
  pdfToPage: [1, 0, 0, -1, 0, 72],
};
const recipe: PdfRasterRecipe = {
  page,
  rotation: 0,
  cropPoints: [0, 0, 72, 72],
  requestedDpi: 1,
  effectiveDpi: 1,
  pixelWidth: 1,
  pixelHeight: 1,
  paperSizeMetres: [0.0254, 0.0254],
  pixelToPdf: [72, 0, 0, -72, 0, 72],
};
function worker(): PdfWorkerClient {
  return {
    async run(_source, job): Promise<PdfJobResult> {
      return job.kind === 'inspect'
        ? { kind: 'inspect', pageCount: 1, page }
        : { kind: 'raster', png, recipe };
    },
    cancel() {},
    dispose() {},
  };
}
function inventory() {
  return new AppearanceAssetInventory({
    decode: async () => ({ width: 1, height: 1, close() {} }),
  });
}
test('PDF originals stay outside image export; independent source instances cannot release each other (#4260)', async () => {
  const images = inventory(),
    file = new File([controlledPdf()], 'drawing.pdf', {
      type: 'application/pdf',
    });
  const first = await PdfAppearanceSource.open(file, images, {
    worker: worker(),
  });
  const second = await PdfAppearanceSource.open(file, images, {
    worker: worker(),
  });
  assert.equal(first.id, second.id, 'document identity is content-derived');
  const a = await first.rasterize({ pageNumber: 1 }),
    b = await second.rasterize({ pageNumber: 1 });
  assert.equal(a.asset.id, b.asset.id);
  assert.notEqual(
    a.sourceId,
    b.sourceId,
    'deduplicating PNG bytes preserves independent source lineage',
  );
  assert.equal(a.documentId, first.id);
  assert.equal(b.documentId, second.id);
  assert.deepEqual(
    [...images.exportResources([a.asset.id]).keys()],
    [a.asset.exportName],
  );
  assert.match(a.asset.exportName, /\.png$/);
  first.dispose();
  assert.ok(images.get(b.asset.id), 'other source still owns the derived page');
  images.retain(b.asset.id, { kind: 'model', id: 'model' });
  second.dispose();
  assert.ok(
    images.get(b.asset.id),
    'committed image survives PDF source removal',
  );
  images.release(b.asset.id, { kind: 'model', id: 'model' });
  assert.equal(images.get(b.asset.id), undefined);
});
test('late PDF rasterization cannot publish or leak a source image after document removal (#4260)', async () => {
  const images = inventory(),
    client = worker();
  let finish: ((result: PdfJobResult) => void) | undefined;
  const run = client.run;
  client.run = (source, job, options) =>
    job.kind === 'inspect'
      ? run(source, job, options)
      : new Promise((resolve) => {
          finish = resolve;
        });
  const document = await PdfAppearanceSource.open(
    new File([controlledPdf()], 'drawing.pdf'),
    images,
    { worker: client },
  );
  const pending = document.rasterize({ pageNumber: 1 });
  document.dispose();
  finish!({ kind: 'raster', png, recipe });
  await assert.rejects(pending, /removed/);
  const owner = { kind: 'source' as const, id: 'probe' },
    asset = await images.add(png, { owner });
  images.release(asset.id, owner);
  assert.equal(
    images.get(asset.id),
    undefined,
    'late rasterization retained no hidden lease',
  );
});
