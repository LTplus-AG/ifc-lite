/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import {
  runPdfJob,
  type PdfEngineBackend,
  type PdfRasterSurface,
} from './engine.js';
import { controlledPdf } from './fixtures.js';
import { inspectImage } from '../asset-format.js';
import { PdfAppearanceError } from './types.js';
async function backend(): Promise<PdfEngineBackend> {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  type NativeCanvas = HTMLCanvasElement & {
    toBuffer(type: string): Uint8Array;
  };
  type Target = { canvas: NativeCanvas; context: CanvasRenderingContext2D };
  let factory: {
    create(width: number, height: number): Target;
    destroy(target: Target): void;
  };
  return {
    getDocument(options) {
      const task = pdf.getDocument(options);
      // The engine awaits/reports this same loading rejection; this observer only captures its canvas factory.
      void task.promise.then(
        (document) => {
          factory = document.canvasFactory as typeof factory;
        },
        () => {},
      );
      return task;
    },
    options: { disableFontFace: true, useSystemFonts: false },
    surface(width, height): PdfRasterSurface {
      const target = factory.create(width, height);
      return {
        ...target,
        async png() {
          return new Uint8Array(target.canvas.toBuffer('image/png'));
        },
        dispose() {
          factory.destroy(target);
        },
      };
    },
  };
}
test('PDF native CropBox/UserUnit/rotation and page selection survive actual decoding (#4260)', async () => {
  const source = controlledPdf(),
    length = source.length,
    engine = await backend();
  const result = await runPdfJob(engine, source, { kind: 'inspect' });
  assert.equal(
    source.length,
    length,
    'PDF.js must not detach original document bytes',
  );
  assert.equal(result.kind, 'inspect');
  if (result.kind !== 'inspect') return;
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.page.viewBox, [10, 20, 110, 92]);
  assert.equal(result.page.userUnit, 2);
  assert.equal(result.page.intrinsicRotation, 90);
  assert.equal(result.page.widthPoints, 144);
  assert.equal(result.page.heightPoints, 200);
  const second = await runPdfJob(engine, source, {
    kind: 'inspect',
    pageNumber: 2,
  });
  assert.equal(second.kind, 'inspect');
  if (second.kind === 'inspect') assert.equal(second.page.widthPoints, 72);
});
test('actual PDF raster respects rotated crop, paper size independent of DPI, and pixel budgets (#4260)', async () => {
  const engine = await backend(),
    source = controlledPdf();
  const results = [];
  for (const dpi of [72, 144]) {
    const result = await runPdfJob(engine, source, {
      kind: 'raster',
      request: {
        pageNumber: 1,
        rotation: 90,
        cropPoints: [20, 10, 72, 36],
        dpi,
      },
    });
    assert.equal(result.kind, 'raster');
    if (result.kind !== 'raster') return;
    results.push(result);
    assert.deepEqual(result.recipe.paperSizeMetres, [0.0254, 0.0127]);
    assert.deepEqual(inspectImage(result.png), {
      mimeType: 'image/png',
      width: dpi,
      height: dpi / 2,
    });
  }
  assert.equal(
    results[0].recipe.pixelToPdf[0],
    results[1].recipe.pixelToPdf[0] * 2,
  );
  const fractional = await runPdfJob(engine, source, {
    kind: 'raster',
    request: {
      pageNumber: 1,
      rotation: 90,
      cropPoints: [20.1, 10.2, 71.3, 35.7],
      dpi: 73,
    },
  });
  assert.equal(fractional.kind, 'raster');
  if (fractional.kind === 'raster') {
    const recipe = fractional.recipe,
      [a, b, c, d, e, f] = recipe.pixelToPdf;
    const corners = [
      [e, f],
      [
        a * recipe.pixelWidth + c * recipe.pixelHeight + e,
        b * recipe.pixelWidth + d * recipe.pixelHeight + f,
      ],
    ];
    for (const [index, expected] of [
      [99.95, 25.1],
      [64.3, 42.95],
    ].entries()) {
      assert.ok(Math.abs(corners[index][0] - expected[0]) < 1e-9);
      assert.ok(Math.abs(corners[index][1] - expected[1]) < 1e-9);
    }
  }
  const bounded = await runPdfJob(engine, source, {
    kind: 'raster',
    request: { pageNumber: 1, dpi: 600, maxPixels: 10000, maxDimension: 100 },
  });
  assert.equal(bounded.kind, 'raster');
  if (bounded.kind === 'raster') {
    assert.ok(bounded.recipe.pixelWidth * bounded.recipe.pixelHeight <= 10000);
    assert.ok(
      bounded.recipe.pixelWidth <= 100 && bounded.recipe.pixelHeight <= 100,
    );
    assert.ok(bounded.recipe.effectiveDpi < 600);
  }
});
test('actual encrypted PDFs provide password-required and incorrect-password diagnostics (#4260)', async () => {
  const document = new jsPDF({
    encryption: { userPassword: 'drawing', ownerPassword: 'owner-secret' },
  });
  document.text('Controlled encrypted drawing', 10, 10);
  const source = new Uint8Array(document.output('arraybuffer')),
    engine = await backend();
  for (const [password, code] of [
    [undefined, 'password-required'],
    ['wrong', 'password-incorrect'],
  ] as const) {
    await assert.rejects(
      runPdfJob(engine, source, { kind: 'inspect' }, { password }),
      (error) => error instanceof PdfAppearanceError && error.code === code,
    );
  }
  assert.equal(
    (
      await runPdfJob(
        engine,
        source,
        { kind: 'inspect' },
        { password: 'drawing' },
      )
    ).kind,
    'inspect',
  );
});
test('cancelled, invalid and out-of-page PDF requests never produce an image (#4260)', async () => {
  const engine = await backend(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runPdfJob(
      engine,
      controlledPdf(),
      { kind: 'inspect' },
      { signal: controller.signal },
    ),
    (error) =>
      error instanceof PdfAppearanceError && error.code === 'cancelled',
  );
  await assert.rejects(
    runPdfJob(engine, new TextEncoder().encode('invalid'), { kind: 'inspect' }),
    (error) =>
      error instanceof PdfAppearanceError && error.code === 'invalid-pdf',
  );
  await assert.rejects(
    runPdfJob(engine, controlledPdf(), {
      kind: 'raster',
      request: { pageNumber: 1, cropPoints: [-1, 0, 10, 10] },
    }),
    /crop/,
  );
});
