/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.drawing — 2D architectural drawings
 *
 * Full access to @ifc-lite/drawing-2d for section cuts, floor plans,
 * elevations, SVG export, hatching, line styles, graphic overrides,
 * architectural symbols, and drawing sheets.
 */

// ============================================================================
// Option types
// ============================================================================

export interface SectionCutOptions {
  axis: 'x' | 'y' | 'z';
  position: number;
  depth?: number;
  showHiddenLines?: boolean;
  showHatching?: boolean;
}

export interface FloorPlanOptions {
  elevation: number;
  depth?: number;
  showHiddenLines?: boolean;
  showHatching?: boolean;
}

export interface SVGExportOptions {
  /** Drawing width in mm */
  width?: number;
  /** Drawing height in mm */
  height?: number;
  /** Scale (e.g. 100 for 1:100) */
  scale?: number;
  /** Include hidden lines (dashed) */
  showHiddenLines?: boolean;
  /** Include hatching patterns */
  showHatching?: boolean;
  /** Line weight multiplier */
  lineWeightFactor?: number;
}

export interface GraphicOverrideOptions {
  /** Preset name or custom override rules */
  preset?: string;
  /** Custom rules (override preset if provided) */
  rules?: Array<{
    criteria: unknown;
    style: unknown;
  }>;
}

export interface SheetOptions {
  /** Paper size name (e.g. 'A1', 'A3', 'ARCH_D') */
  paperSize?: string;
  /** Orientation */
  orientation?: 'landscape' | 'portrait';
  /** Scale for the drawing */
  scale?: number;
  /** Title block fields */
  titleBlock?: Record<string, string>;
}

// ============================================================================
// Dynamic import
// ============================================================================

async function loadDrawing2D(): Promise<Record<string, unknown>> {
  const name = '@ifc-lite/drawing-2d';
  return import(/* webpackIgnore: true */ name) as Promise<Record<string, unknown>>;
}

type AnyFn = (...args: unknown[]) => unknown;

// ============================================================================
// DrawingNamespace
// ============================================================================

/** bim.drawing — 2D architectural drawing generation, styling, and export */
export class DrawingNamespace {

  // --------------------------------------------------------------------------
  // Graphic override presets
  // --------------------------------------------------------------------------

  /** Get all built-in graphic override presets. */
  async getPresets(): Promise<unknown[]> {
    const mod = await loadDrawing2D();
    return mod.BUILT_IN_PRESETS as unknown[];
  }

  /** Get a specific built-in preset by name. */
  async getPreset(name: string): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.getBuiltInPreset as AnyFn)(name);
  }

  /** Get presets filtered by category. */
  async getPresetsByCategory(category: string): Promise<unknown[]> {
    const mod = await loadDrawing2D();
    return (mod.getPresetsByCategory as AnyFn)(category) as Promise<unknown[]>;
  }

  /** Create a graphic override engine from rules. */
  async createOverrideEngine(rules?: unknown[]): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.createOverrideEngine as AnyFn)(rules);
  }

  // --------------------------------------------------------------------------
  // Override criteria builders
  // --------------------------------------------------------------------------

  /** Create a criterion that matches by IFC type(s). */
  async ifcTypeCriterion(types: string | string[], includeSubtypes = true): Promise<unknown> {
    const mod = await loadDrawing2D();
    const arr = Array.isArray(types) ? types : [types];
    return (mod.ifcTypeCriterion as AnyFn)(arr, includeSubtypes);
  }

  /** Create a criterion that matches by property value. */
  async propertyCriterion(propertyName: string, operator: string, value?: unknown, propertySet?: string): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.propertyCriterion as AnyFn)(propertyName, operator, value, propertySet);
  }

  /** Combine criteria with AND logic. */
  async andCriteria(...criteria: unknown[]): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.andCriteria as AnyFn)(...criteria);
  }

  /** Combine criteria with OR logic. */
  async orCriteria(...criteria: unknown[]): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.orCriteria as AnyFn)(...criteria);
  }

  // --------------------------------------------------------------------------
  // Scale & paper
  // --------------------------------------------------------------------------

  /**
   * Get the tightest scale at which a drawing fits the sheet.
   *
   * Sizes are metres; paper is millimetres and defaults to A3 landscape.
   * `height` defaults to `width`, which squares the extent and costs one to
   * two steps of coarseness on an elongated plan (a 30 x 5 m plan squares to
   * 1:200 where it fits at 1:100), so pass the real height when you have it.
   *
   * `paperWidth` and `paperHeight` are independent, so passing one and not the
   * other composes a sheet that is no real paper size: `(30, 20, 594)` is 594
   * wide by A3's 297 tall. Pass both or neither. They are not paired into one
   * argument because that would change the shape of a published signature for
   * a hazard a sentence can cover.
   *
   * Throws on a non-finite or non-positive size. It previously returned a
   * scale for those, so a caller relying on that gets an exception now.
   */
  async getRecommendedScale(
    width: number,
    height: number = width,
    paperWidth?: number,
    paperHeight?: number
  ): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.getRecommendedScale as AnyFn)(width, height, paperWidth, paperHeight);
  }

  /** Get all common scales. */
  async getCommonScales(): Promise<unknown[]> {
    const mod = await loadDrawing2D();
    return mod.COMMON_SCALES as unknown[];
  }

  /** Get available paper sizes. */
  async getPaperSizes(): Promise<unknown[]> {
    const mod = await loadDrawing2D();
    return mod.PAPER_SIZES as unknown[];
  }

  /** Get paper sizes from the registry, optionally by category. */
  async getPaperSizesByCategory(category?: string): Promise<unknown[]> {
    const mod = await loadDrawing2D();
    if (category) {
      return (mod.getPaperSizesByCategory as AnyFn)(category) as Promise<unknown[]>;
    }
    return mod.PAPER_SIZE_REGISTRY as unknown[];
  }

  // --------------------------------------------------------------------------
  // Hatching
  // --------------------------------------------------------------------------

  /** Get all hatch patterns. */
  async getHatchPatterns(): Promise<unknown> {
    const mod = await loadDrawing2D();
    return mod.HATCH_PATTERNS;
  }

  /** Get a hatch pattern by IFC type or material name. */
  async getHatchPattern(key: string): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.getHatchPattern as AnyFn)(key);
  }

  // --------------------------------------------------------------------------
  // Line styles
  // --------------------------------------------------------------------------

  /** Get all line styles. */
  async getLineStyles(): Promise<unknown> {
    const mod = await loadDrawing2D();
    return mod.LINE_STYLES;
  }

  /** Get line weight configuration by IFC type. */
  async getTypeLineWeights(): Promise<unknown> {
    const mod = await loadDrawing2D();
    return mod.TYPE_LINE_WEIGHTS;
  }

  /** Get a specific line style. */
  async getLineStyle(key: string): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.getLineStyle as AnyFn)(key);
  }

  /** Get dash patterns. */
  async getDashPatterns(): Promise<unknown> {
    const mod = await loadDrawing2D();
    return mod.DASH_PATTERNS;
  }

  // --------------------------------------------------------------------------
  // Layer mapping
  // --------------------------------------------------------------------------

  /** Get the default AIA layer definitions. */
  async getDefaultLayers(): Promise<unknown> {
    const mod = await loadDrawing2D();
    return mod.DEFAULT_LAYERS;
  }

  /** Get the AIA layer for an IFC type. */
  async getLayerForIfcType(ifcType: string): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.getLayerForIfcType as AnyFn)(ifcType);
  }

  // --------------------------------------------------------------------------
  // Symbols
  // --------------------------------------------------------------------------

  /** Generate a door symbol. */
  async generateDoorSymbol(params: unknown): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.generateDoorSymbol as AnyFn)(params);
  }

  /** Generate a window symbol. */
  async generateWindowSymbol(params: unknown): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.generateWindowSymbol as AnyFn)(params);
  }

  /** Generate a stair arrow. */
  async generateStairArrow(params: unknown): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.generateStairArrow as AnyFn)(params);
  }

  // --------------------------------------------------------------------------
  // Sheet generation
  // --------------------------------------------------------------------------

  /** Get available frame presets. */
  async getFramePresets(): Promise<unknown> {
    const mod = await loadDrawing2D();
    return mod.FRAME_PRESETS;
  }

  /** Create a drawing frame. */
  async createFrame(options: unknown): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.createFrame as AnyFn)(options);
  }

  /** Get available title block presets. */
  async getTitleBlockPresets(): Promise<unknown> {
    const mod = await loadDrawing2D();
    return mod.TITLE_BLOCK_PRESETS;
  }

  /** Create a title block. */
  async createTitleBlock(options: unknown): Promise<unknown> {
    const mod = await loadDrawing2D();
    return (mod.createTitleBlock as AnyFn)(options);
  }

  // --------------------------------------------------------------------------
  // SVG export
  // --------------------------------------------------------------------------

  /** Export drawing data to SVG string. */
  async exportToSVG(drawing: unknown, options?: SVGExportOptions): Promise<string> {
    const mod = await loadDrawing2D();
    return (mod.exportToSVG as AnyFn)(drawing, options) as Promise<string>;
  }

  // --------------------------------------------------------------------------
  // Math utilities (useful for custom drawing logic)
  // --------------------------------------------------------------------------

  /** Get the math utilities module (vec3, point2d, bounds, etc.). */
  async math(): Promise<{
    vec3: AnyFn;
    vec3Add: AnyFn;
    vec3Sub: AnyFn;
    vec3Scale: AnyFn;
    vec3Dot: AnyFn;
    vec3Cross: AnyFn;
    vec3Length: AnyFn;
    vec3Normalize: AnyFn;
    vec3Distance: AnyFn;
    point2D: AnyFn;
    point2DAdd: AnyFn;
    point2DSub: AnyFn;
    point2DDistance: AnyFn;
    lineLength: AnyFn;
    lineMidpoint: AnyFn;
    lineDirection: AnyFn;
    boundsEmpty: AnyFn;
    boundsExtendPoint: AnyFn;
    boundsCenter: AnyFn;
    boundsSize: AnyFn;
    EPSILON: number;
    [key: string]: unknown;
  }> {
    const mod = await loadDrawing2D();
    return mod as unknown as ReturnType<typeof this.math> extends Promise<infer T> ? T : never;
  }

  // --------------------------------------------------------------------------
  // GPU acceleration check
  // --------------------------------------------------------------------------

  /** Check if GPU compute is available for accelerated section cutting. */
  async isGPUComputeAvailable(): Promise<boolean> {
    const mod = await loadDrawing2D();
    return (mod.isGPUComputeAvailable as () => boolean)();
  }
}
