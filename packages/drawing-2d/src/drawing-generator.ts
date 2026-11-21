/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing2D Generator - High-level orchestrator for 2D drawing generation
 *
 * Combines all components:
 * - Section cutting (GPU or CPU)
 * - Edge extraction
 * - Hidden line removal
 * - Hatching
 * - SVG export
 */

import type { MeshData } from '@ifc-lite/geometry';
import { selectModelMeshes } from '@ifc-lite/geometry/geometry-class';
import type {
  SectionConfig,
  SectionAxis,
  Drawing2D,
  DrawingLine,
  ProfileEntry,
  MeshOutline2D,
} from './types.js';
import { DEFAULT_SECTION_CONFIG } from './types.js';
import { HatchGenerator } from './hatch-generator.js';
import { SVGExporter } from './svg-exporter.js';
import type { SVGExportOptions } from './svg-exporter.js';
import { GPUSectionCutter } from './gpu-section-cutter.js';
import { meshArraySource, type DrawingMeshSource } from './drawing-mesh-source.js';
import { DrawingSession } from './drawing-session.js';
import { generateWithOpeningSymbols, type PlanSymbolOptions } from './symbols/opening-symbols.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface GeneratorOptions {
  /** Use GPU acceleration if available */
  useGPU: boolean;
  /** Include hidden lines in output */
  includeHiddenLines: boolean;
  /** Include projection lines (visible geometry beyond cut) */
  includeProjection: boolean;
  /** Include silhouettes and feature edges */
  includeEdges: boolean;
  /** Merge collinear line segments */
  mergeLines: boolean;
  /**
   * Optional winding-robust outline provider (the Rust `meshOutline2d` WASM
   * binding, issue #979). When supplied, non-extruded geometry projects via
   * this footprint outline instead of the normal-based mesh silhouette (which
   * ifc-lite's unreliable winding can break). Return `null` to fall back to
   * silhouette extraction for that mesh.
   *
   * CARDINAL planes only: the callback receives just (axis, flipped) and its
   * output is in cardinal projection space, so on a custom (face-picked)
   * plane the generator bypasses it and uses the plane-aware silhouette path
   * instead (PR #2644 review).
   */
  outlineProvider?: (mesh: MeshData, axis: SectionAxis, flipped: boolean) => MeshOutline2D | null;
  /**
   * Pre-projected lines merged in BEFORE the hidden-line stage (issue #2042):
   * the section RIM of a CPU half-space clip. Build them with
   * `projectWorldLineSeeds`, never a hand-rolled projection — they must share
   * this config's plane basis and view-depth convention.
   *
   * They are classified alongside the projection lines even though they carry
   * `category: 'cut'`: cutter-produced cut lines sit in the plane at view
   * depth 0 and can never be occluded, but on an oblique 3D view a rim edge
   * can sit behind other geometry and must print dashed.
   */
  extraLines?: DrawingLine[];
  /** Progress callback */
  onProgress?: (stage: string, progress: number) => void;
  /** Abandons the drawing between batches: the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: GeneratorOptions = {
  useGPU: true,
  includeHiddenLines: true,
  includeProjection: true,
  includeEdges: true,
  mergeLines: true,
};

export interface GeneratorProgress {
  stage: 'cutting' | 'polygons' | 'edges' | 'hidden' | 'merging' | 'complete';
  progress: number;
  message: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAWING GENERATOR CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class Drawing2DGenerator {
  private gpuCutter: GPUSectionCutter | null = null;
  private hatchGenerator = new HatchGenerator();
  private svgExporter = new SVGExporter();

  private gpuDevice: GPUDevice | null = null;
  private initialized = false;

  /**
   * Initialize the generator with optional GPU device
   */
  async initialize(gpuDevice?: GPUDevice): Promise<void> {
    if (gpuDevice) {
      this.gpuDevice = gpuDevice;
      this.gpuCutter = new GPUSectionCutter(gpuDevice);
      await this.gpuCutter.initialize(100000); // Initial capacity
    }
    this.initialized = true;
  }

  /**
   * Generate a complete 2D drawing from a resident mesh array. Type-library
   * geometry (`geometryClass` 1/2) is left out, as in the viewer's Model view.
   */
  async generate(
    meshes: MeshData[],
    config: SectionConfig,
    options: Partial<GeneratorOptions> = {},
    profiles?: ProfileEntry[],
  ): Promise<Drawing2D> {
    return this.generateFromSource(meshArraySource(selectModelMeshes(meshes)), config, options, profiles);
  }

  /**
   * Generate a complete 2D drawing from a replayable source (#10264), in at
   * most two passes and without holding the source's meshes: see
   * `DrawingMeshSource`. The result equals `generate` over one pass's meshes.
   * An error thrown by the source (a stale or replaced generation) or an
   * aborted `options.signal` rejects the drawing; nothing partial is returned.
   */
  async generateFromSource(
    source: DrawingMeshSource,
    config: SectionConfig,
    options: Partial<GeneratorOptions> = {},
    profiles?: ProfileEntry[],
  ): Promise<Drawing2D> {
    const session = this.beginDrawing(config, options, profiles);
    try {
      for await (const batch of source.pass('geometry')) await session.addGeometry(batch);
      const needs = session.endGeometry();
      if (needs.depthRaster || needs.openSurfaceEntities.size > 0) {
        for await (const batch of source.pass('occlusion')) session.addOcclusion(batch);
      }
      return session.finish();
    } catch (error) {
      session.cancel();
      throw error;
    }
  }

  /**
   * Start one drawing fed batch by batch (see `DrawingSession`): for callers
   * that lease geometry chunk by chunk. `generateFromSource` drives the same.
   */
  beginDrawing(config: SectionConfig, options: Partial<GeneratorOptions> = {}, profiles?: readonly ProfileEntry[]): DrawingSession {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    // GPU path. Falls back to CPU when a custom (face-picked) plane is active
    // because GPUSectionCutter still assumes cardinal axes.
    const gpuCutter = opts.useGPU && this.gpuDevice && !config.plane.customPlane ? this.gpuCutter : null;
    return new DrawingSession(config, opts, profiles, gpuCutter);
  }

  /**
   * Export drawing to SVG string
   */
  exportSVG(drawing: Drawing2D, options?: SVGExportOptions): string {
    return this.svgExporter.export(drawing, options);
  }

  /**
   * Generate hatching lines for cut polygons
   */
  generateHatching(drawing: Drawing2D): DrawingLine[] {
    const hatchResults = this.hatchGenerator.generateHatches(
      drawing.cutPolygons,
      drawing.config.scale
    );

    const hatchLines: DrawingLine[] = [];
    for (const result of hatchResults) {
      for (const hatchLine of result.lines) {
        hatchLines.push({
          line: hatchLine.line,
          category: 'annotation',
          visibility: 'visible',
          entityId: hatchLine.entityId,
          ifcType: hatchLine.ifcType,
          modelIndex: hatchLine.modelIndex,
          depth: 0,
        });
      }
    }

    return hatchLines;
  }

  /**
   * Dispose GPU resources
   */
  dispose(): void {
    if (this.gpuCutter) {
      this.gpuCutter.destroy();
      this.gpuCutter = null;
    }
    this.gpuDevice = null;
    this.initialized = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVENIENCE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a section configuration from simple parameters
 */
export function createSectionConfig(
  axis: 'x' | 'y' | 'z',
  position: number,
  options: Partial<Omit<SectionConfig, 'plane'>> = {}
): SectionConfig {
  return {
    plane: {
      axis,
      position,
      flipped: false,
    },
    ...DEFAULT_SECTION_CONFIG,
    ...options,
  };
}

/**
 * Quick helper to generate a floor plan. Doors and windows crossing the cut
 * are drawn as symbols (`planSymbols`) unless `openingSymbols` is false.
 */
export async function generateFloorPlan(
  meshes: MeshData[],
  elevation: number,
  options?: Partial<GeneratorOptions> & PlanSymbolOptions
): Promise<Drawing2D> {
  const generator = new Drawing2DGenerator();
  try {
    await generator.initialize();
    const config = createSectionConfig('y', elevation, { projectionDepth: 3, scale: 100 });
    return await generateWithOpeningSymbols(meshes, config, options, (drawn) => generator.generate(drawn, config, options));
  } finally {
    generator.dispose();
  }
}

/**
 * Quick helper to generate a section
 */
export async function generateSection(
  meshes: MeshData[],
  axis: 'x' | 'z',
  position: number,
  options?: Partial<GeneratorOptions>
): Promise<Drawing2D> {
  const generator = new Drawing2DGenerator();
  try {
    await generator.initialize();

    const config = createSectionConfig(axis, position, {
      projectionDepth: 10,
      scale: 100,
    });

    return await generator.generate(meshes, config, options);
  } finally {
    generator.dispose();
  }
}
