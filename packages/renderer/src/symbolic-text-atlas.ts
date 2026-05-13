/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runtime Canvas2D glyph atlas for IfcAnnotation text labels.
 *
 * Rasterises each requested glyph once into a backing canvas, packed
 * left-to-right in fixed-height rows, and exposes a per-glyph quad descriptor
 * (atlas UV bounds + advance) that the WebGPU text pipeline reads. The atlas
 * canvas itself can be uploaded straight to a `GPUTexture` via
 * `device.queue.copyExternalImageToTexture` — no intermediate ImageBitmap.
 *
 * Design notes:
 * - We render at a high pixel size (the `glyphPx` constant) so the atlas is
 *   crisp at typical zoom; downstream scales the quad in world units. For
 *   extreme zoom-in the rasterised glyph will eventually pixelate — that's
 *   accepted, the alternative (signed-distance fields) is significantly more
 *   infrastructure (see #659 discussion).
 * - Glyphs are added on demand. Strings render by iterating code points
 *   (so most BMP characters work; surrogate pairs are passed through to
 *   Canvas2D which handles ligatures and combining marks well enough for
 *   architectural labels).
 * - The atlas does NOT support live re-pack. If the canvas fills, new glyphs
 *   fall back to the missing-glyph placeholder. For floor-plan annotations
 *   that's effectively never since the character set is small.
 */

const DEFAULT_ATLAS_SIZE = 1024;
const DEFAULT_GLYPH_PX = 48;        // canvas pixels per glyph height
const DEFAULT_PADDING = 2;          // pixels of empty space around each glyph (prevents bleed)
const DEFAULT_FONT_FAMILY =
  '"Inter", "Helvetica Neue", "Segoe UI", system-ui, -apple-system, sans-serif';

/**
 * Per-glyph atlas record. UV coordinates are in [0..1] over the atlas; size /
 * advance / baseline are in canvas pixels (atlas reference frame). World-space
 * scaling happens in the text pipeline based on the IFC text height attribute.
 */
export interface GlyphInfo {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Glyph quad width in atlas pixels (excludes padding). */
  widthPx: number;
  /** Glyph quad height in atlas pixels (excludes padding). */
  heightPx: number;
  /** Horizontal advance (pen movement) in atlas pixels. */
  advancePx: number;
  /** Distance from the rendered quad's top edge to the baseline, in atlas pixels. */
  baselinePx: number;
}

export interface GlyphAtlasOptions {
  /** Width/height of the backing canvas (square). Defaults to 1024. */
  atlasSize?: number;
  /** Cap height of rendered glyphs in canvas pixels. Defaults to 48. */
  glyphPx?: number;
  /** CSS font-family string. Defaults to a permissive system-font stack. */
  fontFamily?: string;
}

export class SymbolicTextAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly atlasSize: number;
  readonly glyphPx: number;
  readonly rowHeight: number;
  /** Distance from glyph top to baseline, constant for the chosen font size. */
  readonly baselinePx: number;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly glyphs = new Map<string, GlyphInfo>();
  private cursorX = DEFAULT_PADDING;
  private cursorY = DEFAULT_PADDING;
  private version = 0;

  constructor(opts: GlyphAtlasOptions = {}) {
    this.atlasSize = opts.atlasSize ?? DEFAULT_ATLAS_SIZE;
    this.glyphPx = opts.glyphPx ?? DEFAULT_GLYPH_PX;
    this.rowHeight = this.glyphPx + DEFAULT_PADDING * 2;
    // Baseline ≈ 0.8 * cap height for sans-serif fonts. Good enough for
    // architectural labels; the exact value comes from the actual font
    // metrics returned by measureText below, but we still need a default for
    // alignment math before any glyph is laid out.
    this.baselinePx = Math.round(this.glyphPx * 0.8);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.atlasSize;
    this.canvas.height = this.atlasSize;

    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) {
      throw new Error('SymbolicTextAtlas: 2D canvas context unavailable');
    }
    this.ctx = ctx;
    this.ctx.font = `${this.glyphPx}px ${opts.fontFamily ?? DEFAULT_FONT_FAMILY}`;
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.fillStyle = 'white';
    // Transparent background — the WebGPU sampler multiplies alpha by the
    // pipeline's color tint.
    this.ctx.clearRect(0, 0, this.atlasSize, this.atlasSize);
  }

  /** Bumps each time a new glyph is rasterised so the renderer knows to re-upload. */
  getVersion(): number {
    return this.version;
  }

  /**
   * Get or lazily rasterise a glyph. Returns `null` when the atlas is full —
   * callers should fall back to a missing-glyph quad (typically the space
   * character or a small box).
   */
  getOrAddGlyph(char: string): GlyphInfo | null {
    let glyph = this.glyphs.get(char);
    if (glyph) return glyph;

    const metrics = this.ctx.measureText(char);
    // Some browsers don't report actualBoundingBox* on every glyph (e.g.
    // legacy Safari for some emoji); fall back to advance × glyph height.
    const ascent = metrics.actualBoundingBoxAscent ?? this.baselinePx;
    const descent = metrics.actualBoundingBoxDescent ?? this.glyphPx - this.baselinePx;
    const widthPx = Math.max(1, Math.ceil(metrics.width));
    const heightPx = Math.max(1, Math.ceil(ascent + descent));

    // Wrap to next row if needed.
    if (this.cursorX + widthPx + DEFAULT_PADDING > this.atlasSize) {
      this.cursorX = DEFAULT_PADDING;
      this.cursorY += this.rowHeight;
    }
    if (this.cursorY + heightPx + DEFAULT_PADDING > this.atlasSize) {
      // Atlas full — caller falls back to placeholder.
      return null;
    }

    // Draw glyph at the cursor. The pen sits on the baseline → draw at
    // (cursorX, cursorY + ascent).
    this.ctx.fillText(char, this.cursorX, this.cursorY + ascent);

    glyph = {
      u0: this.cursorX / this.atlasSize,
      v0: this.cursorY / this.atlasSize,
      u1: (this.cursorX + widthPx) / this.atlasSize,
      v1: (this.cursorY + heightPx) / this.atlasSize,
      widthPx,
      heightPx,
      advancePx: metrics.width,
      baselinePx: ascent,
    };
    this.glyphs.set(char, glyph);

    this.cursorX += widthPx + DEFAULT_PADDING;
    this.version++;
    return glyph;
  }

  /**
   * Layout a UTF-16 string against the atlas. Code points outside the BMP are
   * passed through as surrogate pairs which Canvas2D renders correctly. Empty
   * advance entries are emitted for missing glyphs so the layout cursor still
   * progresses.
   *
   * `out` is filled with one record per code point. Returns the total advance
   * width in atlas pixels (caller uses this for alignment).
   */
  layoutString(s: string): { glyphs: GlyphLayoutEntry[]; totalAdvancePx: number } {
    const out: GlyphLayoutEntry[] = [];
    let totalAdvancePx = 0;

    for (const codePoint of s) {
      const glyph = this.getOrAddGlyph(codePoint);
      if (glyph) {
        out.push({
          xOffsetPx: totalAdvancePx,
          glyph,
        });
        totalAdvancePx += glyph.advancePx;
      } else {
        // Missing glyph — advance by 0.5 em (half a cap height) so the layout
        // doesn't collapse but the missing char is visually obvious as a gap.
        totalAdvancePx += this.glyphPx * 0.5;
      }
    }

    return { glyphs: out, totalAdvancePx };
  }
}

export interface GlyphLayoutEntry {
  /** Pen position (in atlas pixels) where this glyph's left edge sits. */
  xOffsetPx: number;
  glyph: GlyphInfo;
}
