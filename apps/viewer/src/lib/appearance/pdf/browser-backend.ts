/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDF_LIMITS, PdfAppearanceError } from './types.js';
import type { PdfEngineBackend } from './engine.js';
const resources = import.meta.glob(
  [
    '/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*.{bcmap,pfb,ttf,wasm,js}',
    '/node_modules/pdfjs-dist/{LICENSE,cmaps/LICENSE*,standard_fonts/LICENSE*,wasm/LICENSE*}',
  ],
  { eager: true, query: '?url', import: 'default' },
) as Record<string, string>;
class BinaryDataFactory {
  async fetch({
    kind,
    filename,
  }: {
    kind: string;
    filename: string;
  }): Promise<Uint8Array> {
    const folders: Record<string, string> = {
      cMapUrl: 'cmaps',
      standardFontDataUrl: 'standard_fonts',
      wasmUrl: 'wasm',
    };
    const folder = folders[kind];
    const url = resources[`/node_modules/pdfjs-dist/${folder}/${filename}`];
    if (!url)
      throw new PdfAppearanceError(
        'unsupported',
        `The PDF decoder resource ${filename} is unavailable.`,
      );
    const response = await fetch(url);
    if (!response.ok)
      throw new PdfAppearanceError(
        'render',
        `Could not load PDF decoder resource ${filename}.`,
      );
    return new Uint8Array(await response.arrayBuffer());
  }
}
function validateCanvasExtent(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > PDF_LIMITS.maxDimension ||
    height > PDF_LIMITS.maxDimension ||
    width * height > PDF_LIMITS.maxPixels
  ) {
    throw new PdfAppearanceError(
      'budget',
      'A PDF intermediate image exceeds the pixel budget.',
    );
  }
}
class CanvasFactory {
  create(width: number, height: number) {
    validateCanvasExtent(width, height);
    const canvas = new OffscreenCanvas(width, height),
      context = canvas.getContext('2d');
    if (!context)
      throw new PdfAppearanceError(
        'unsupported',
        'PDF page rendering needs OffscreenCanvas support.',
      );
    return { canvas, context };
  }
  reset(target: { canvas: OffscreenCanvas }, width: number, height: number) {
    validateCanvasExtent(width, height);
    target.canvas.width = width;
    target.canvas.height = height;
  }
  destroy(target: {
    canvas: OffscreenCanvas | null;
    context: OffscreenCanvasRenderingContext2D | null;
  }) {
    if (target.canvas) target.canvas.width = target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  }
}
/** SVG URL filters require a DOM. Reject their use instead of silently altering appearance. */
class FilterFactory {
  addFilter(maps?: number[][] | null) {
    if (
      !maps ||
      maps.every((map) => map.every((value, index) => value === index))
    )
      return 'none';
    throw new PdfAppearanceError(
      'unsupported',
      'This page uses PDF color-transfer filters unavailable in worker rendering. Export this page as a PNG.',
    );
  }
  addAlphaFilter() {
    throw new PdfAppearanceError(
      'unsupported',
      'This page uses an unsupported PDF alpha filter. Export this page as a PNG.',
    );
  }
  addLuminosityFilter() {
    throw new PdfAppearanceError(
      'unsupported',
      'This page uses an unsupported PDF luminosity filter. Export this page as a PNG.',
    );
  }
  addKnockoutFilter() {
    throw new PdfAppearanceError(
      'unsupported',
      'This page uses an unsupported PDF knockout filter. Export this page as a PNG.',
    );
  }
  destroy() {}
}
export function browserPdfBackend(): PdfEngineBackend {
  if (typeof OffscreenCanvas === 'undefined')
    throw new PdfAppearanceError(
      'unsupported',
      'PDF page rendering needs a browser with OffscreenCanvas support.',
    );
  GlobalWorkerOptions.workerSrc = workerUrl;
  return {
    getDocument,
    options: {
      CanvasFactory,
      BinaryDataFactory,
      FilterFactory,
      useWorkerFetch: false,
      disableFontFace: true,
      useSystemFonts: false,
    },
    surface(width, height) {
      const factory = new CanvasFactory(),
        target = factory.create(width, height);
      return {
        // PDF.js types expose DOM canvas only; its CanvasGraphics consumes the shared 2D API.
        canvas: target.canvas as unknown as HTMLCanvasElement,
        context: target.context as unknown as CanvasRenderingContext2D,
        async png() {
          return new Uint8Array(
            await (
              await target.canvas.convertToBlob({ type: 'image/png' })
            ).arrayBuffer(),
          );
        },
        dispose() {
          factory.destroy(target);
        },
      };
    },
  };
}
