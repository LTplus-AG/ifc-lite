/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { fitRasterPixels, type RasterFit } from '@ifc-lite/drawing-2d';
/**
 * Dots per inch of paper the sheet raster is built at.
 *
 * Fixed, with no UI control anywhere: `handleExportPDF` is a single toolbar
 * action. That is why the ceiling below CAPS rather than REFUSES — a refusal
 * would have no setting to send the user to, and the sheet's paper size is
 * the deliverable, not a preference.
 */
export const SHEET_PDF_DPI = 300;

/**
 * Pixel budget for one sheet raster, taken from WebKit's own canvas cap
 * rather than picked as a round number: `CanvasBase::maxCanvasArea()`
 * (Source/WebCore/html/CanvasBase.cpp) returns `8192 * 8192` on the iOS
 * family and `16384 * 16384` elsewhere. The lower of the two is the one that
 * has to hold, because a canvas over the cap does not report itself:
 * `CanvasBase::validateArea()` logs a console warning and returns false, the
 * canvas gets no backing store, `getContext('2d')` still returns a live
 * context, the paint calls become no-ops, and `toDataURL()` then returns the
 * literal string `"data:,"` — `encodeDataURL(RefPtr<ImageBuffer>&&)` in
 * Source/WebCore/platform/graphics/ImageUtilities.cpp returns `"data:,"_s`
 * for a null buffer. Nothing throws at any point.
 *
 * At {@link SHEET_PDF_DPI} that cap binds from ANSI D upwards. The papers
 * that need it are the big ones — ARCH E is 14400 x 10800 = 155,520,000 px
 * and A0 is 14043 x 9933 = 139,489,119 px, both far past even the desktop
 * cap's memory cost (155.5 Mpx x 4 bytes = 622 MB for the bitmap alone).
 *
 * NOT verified in any real browser. The value and the failure mode are read
 * off WebKit's source; Chrome's and Firefox's caps differ and are not
 * modelled, and Safari's separate TOTAL canvas-memory limit is a second
 * ceiling this budget cannot rule out — which is why the raster result is
 * validated below as well as sized.
 */
export const MAX_SHEET_RASTER_PIXELS = 8192 * 8192;

/**
 * Per-side cap: the side length WebKit's non-iOS area cap is expressed as,
 * and the same number `@ifc-lite/drawing-2d` already uses for the 3D-view
 * PDF's shaded underlay (`MAX_SHADING_DIMENSION_PX`). No registry paper
 * reaches it at {@link SHEET_PDF_DPI} (ARCH E's long side is 14400 px); it
 * exists for a custom paper size, which `DrawingSheet.paper` permits.
 */
export const MAX_SHEET_RASTER_DIMENSION_PX = 16_384;

/** A raster, plus what it cost to fit it inside the budget. */
interface SheetRaster {
  dataUrl: string;
  fit: RasterFit;
}

/**
 * Rasterize an SVG string to a PNG data URL, sized to exactly `widthMm` x
 * `heightMm` on paper (issues #2941/#2942). The sheet frame, title block and
 * scale bar only exist inside `generateSheetSVG` — SVG, Print and the
 * DXF-underlay path all render that exact string and the reporter confirmed
 * those are correct. Rather than re-deriving a second, independent sheet
 * layout for jsPDF's vector primitives (the old "v1" PDF path did exactly
 * that and dropped the frame/scale bar entirely, and used
 * `displayOptions.scale` instead of the sheet's own scale), rasterize the
 * SAME svg the working exporters use so the PDF cannot drift from them.
 *
 * The pixel grid comes from `fitRasterPixels`, the same helper the 3D-view
 * PDF's shaded underlay uses, so the two raster paths cannot drift into two
 * different cap policies. It scales BOTH sides by one factor, so a capped
 * sheet is blurrier and never mis-scaled: the caller still places the image
 * across the full paper rectangle in millimetres, never at `px / dpi`.
 *
 * `fit.capped` is returned rather than swallowed. A user who asked for a
 * 300 dpi sheet and silently got 104 is the same defect as a blank page, one
 * step quieter.
 */
export function rasterizeSvgToPngDataUrl(
  svgString: string,
  widthMm: number,
  heightMm: number,
  dpi = SHEET_PDF_DPI,
): Promise<SheetRaster> {
  return new Promise((resolve, reject) => {
    const fit = fitRasterPixels(
      widthMm,
      heightMm,
      dpi,
      MAX_SHEET_RASTER_PIXELS,
      MAX_SHEET_RASTER_DIMENSION_PX,
    );
    const { widthPx, heightPx } = fit;

    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = widthPx;
        canvas.height = heightPx;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        // The sheet SVG already paints its own white background rect, but a
        // canvas starts transparent — belt-and-braces against a transparent
        // PDF page if that rect is ever clipped away.
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, widthPx, heightPx);
        ctx.drawImage(img, 0, 0, widthPx, heightPx);

        const dataUrl = canvas.toDataURL('image/png');
        // The pixel budget above is necessary, not sufficient. Safari
        // enforces a separate TOTAL canvas-memory limit, and any browser can
        // fail a 100+ MB allocation on a low-memory device; in both cases the
        // buffer is simply absent and this comes back as `"data:,"` with no
        // exception raised. Handing that to `jsPDF.addImage` produces a
        // decoder complaint about a PNG signature, which tells the user
        // nothing they can act on — and if a browser ever returned a valid
        // all-white PNG instead, the export would "succeed" with a blank
        // page. Refuse the result here, naming the way out.
        if (!dataUrl.startsWith('data:image/png')) {
          throw new Error(
            `the browser returned an empty ${widthPx}x${heightPx} px canvas for this ` +
            `${Math.round(widthMm)}x${Math.round(heightMm)} mm sheet. Try a smaller paper ` +
            `size, or use the SVG export, which is vector and has no pixel limit.`,
          );
        }
        resolve({ dataUrl, fit });
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Failed to rasterize sheet SVG'));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load sheet SVG for PDF export'));
    };
    img.src = url;
  });
}
