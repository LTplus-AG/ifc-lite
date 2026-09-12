/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { getDocument, RenderTask } from 'pdfjs-dist';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api.js';
import { decodePdfVectorPage, type PdfVectorDecoder } from './vector-adapter.js';
import { pageInfo, rasterRecipe } from './raster-recipe.js';
import {
  PDF_LIMITS,
  PdfAppearanceError,
  type PdfJob,
  type PdfJobResult,
} from './types.js';
export interface PdfRasterSurface {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  png(): Promise<Uint8Array>;
  dispose(): void;
}
export interface PdfEngineBackend {
  getDocument: typeof getDocument;
  vectorDecoder?: PdfVectorDecoder;
  options?: Partial<DocumentInitParameters>;
  surface(width: number, height: number): PdfRasterSurface;
}
export function pdfError(error: unknown): PdfAppearanceError {
  if (error instanceof PdfAppearanceError) return error;
  if (error instanceof Error && error.name === 'PasswordException') {
    const incorrect = 'code' in error && error.code === 2;
    return new PdfAppearanceError(
      incorrect ? 'password-incorrect' : 'password-required',
      incorrect
        ? 'That PDF password is incorrect. Try again.'
        : 'This PDF needs a password before pages can be imported.',
    );
  }
  if (
    error instanceof Error &&
    ['AbortError', 'RenderingCancelledException'].includes(error.name)
  )
    return new PdfAppearanceError('cancelled', 'PDF import cancelled.');
  return new PdfAppearanceError(
    error instanceof Error && error.name === 'InvalidPDFException'
      ? 'invalid-pdf'
      : 'render',
    `Cannot read this PDF page. ${error instanceof Error ? error.message : String(error)}`,
  );
}
/** Decode/render only. IFC placement and drawing calibration belong to the shared authoring layer. */
export async function runPdfJob(
  backend: PdfEngineBackend,
  source: Uint8Array,
  job: PdfJob,
  options: { password?: string; signal?: AbortSignal } = {},
): Promise<PdfJobResult> {
  if (source.byteLength === 0 || source.byteLength > PDF_LIMITS.maxBytes)
    throw new PdfAppearanceError(
      'budget',
      'Choose a PDF no larger than 64 MiB.',
    );
  if (options.signal?.aborted)
    throw new PdfAppearanceError('cancelled', 'PDF import cancelled.');
  // PDF.js may transfer data to its parsing worker. Never detach a source owner's bytes.
  const loading = backend.getDocument({
    ...backend.options,
    data: new Uint8Array(source),
    password: options.password,
    enableXfa: false,
    stopAtErrors: true,
    maxImageSize: PDF_LIMITS.maxPixels,
    canvasMaxAreaInBytes: PDF_LIMITS.maxPixels * 4,
  });
  let render: RenderTask | undefined;
  const abort = () => {
    render?.cancel();
    void loading
      .destroy()
      .catch((error) =>
        console.warn('[PDF] cancellation cleanup failed', error),
      );
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const document = await loading.promise;
    if (document.numPages > PDF_LIMITS.maxPages)
      throw new PdfAppearanceError(
        'budget',
        `Choose a PDF with at most ${PDF_LIMITS.maxPages} pages.`,
      );
    const pageNumber =
      job.kind === 'inspect' ? (job.pageNumber ?? 1) : job.request.pageNumber;
    if (
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > document.numPages
    )
      throw new PdfAppearanceError('invalid-pdf', 'Choose a page in this PDF.');
    const page = await document.getPage(pageNumber);
    try {
      if (options.signal?.aborted)
        throw new PdfAppearanceError('cancelled', 'PDF import cancelled.');
      if (job.kind === 'inspect')
        return {
          kind: 'inspect',
          pageCount: document.numPages,
          page: pageInfo(page),
        };
      if (job.kind === 'vectors') {
        if (!backend.vectorDecoder) throw new PdfAppearanceError('unsupported', 'PDF vector decoding is unavailable.');
        // Optional-content visibility is a document setting; the adapter resolves it per marked-content scope.
        const optionalContent = await document.getOptionalContentConfig({ intent: 'display' });
        return { kind: 'vectors', page: await decodePdfVectorPage(page, source, job.request, backend.vectorDecoder, options.signal, { optionalContent }) };
      }
      const recipe = rasterRecipe(page, job.request),
        scale = recipe.effectiveDpi / 72;
      const scaleX = recipe.pixelWidth / recipe.cropPoints[2],
        scaleY = recipe.pixelHeight / recipe.cropPoints[3];
      const surface = backend.surface(recipe.pixelWidth, recipe.pixelHeight);
      try {
        render = page.render({
          canvas: surface.canvas,
          canvasContext: surface.context,
          viewport: page.getViewport({
            scale,
            rotation: (page.rotate + recipe.rotation) % 360,
          }),
          transform: [
            scaleX / scale,
            0,
            0,
            scaleY / scale,
            -recipe.cropPoints[0] * scaleX,
            -recipe.cropPoints[1] * scaleY,
          ],
          background: 'rgb(255,255,255)',
        });
        await render.promise;
        const png = await surface.png();
        if (options.signal?.aborted)
          throw new PdfAppearanceError('cancelled', 'PDF import cancelled.');
        return { kind: 'raster', png, recipe };
      } finally {
        surface.dispose();
      }
    } finally {
      page.cleanup();
    }
  } catch (error) {
    if (options.signal?.aborted)
      throw new PdfAppearanceError('cancelled', 'PDF import cancelled.');
    throw pdfError(error);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await loading.destroy();
  }
}
