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
import type {
  SectionConfig,
  SectionAxis,
  Drawing2D,
  DrawingLine,
  CutSegment,
  Bounds2D,
  LineCategory,
  ProfileEntry,
  MeshOutline2D,
} from './types.js';
import { DEFAULT_SECTION_CONFIG } from './types.js';
import { SectionCutter } from './section-cutter.js';
import { PolygonBuilder } from './polygon-builder.js';
import { OpenSurfaceAccumulator, openSurfaceCandidates } from './open-surface.js';
import { EdgeExtractor } from './edge-extractor.js';
import { HiddenLineClassifier } from './hidden-line.js';
import { mergeDrawingLines } from './line-merger.js';
import { HatchGenerator } from './hatch-generator.js';
import { SVGExporter } from './svg-exporter.js';
import type { SVGExportOptions } from './svg-exporter.js';
import { GPUSectionCutter } from './gpu-section-cutter.js';
import { clipMeshToProjectionWindow } from './projection-clip.js';
import { ProjectionCollector } from './projection-collector.js';
import { meshArraySource, type DrawingMeshSource } from './drawing-mesh-source.js';
import {
  boundsEmpty,
  boundsExtendLine,
} from './math.js';

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
  private cpuCutter: SectionCutter | null = null;
  private polygonBuilder = new PolygonBuilder();
  private edgeExtractor = new EdgeExtractor(30); // 30° crease angle
  private hiddenLineClassifier = new HiddenLineClassifier({ resolution: 1024 });
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
   * Generate a complete 2D drawing from a resident mesh array.
   */
  async generate(
    meshes: MeshData[],
    config: SectionConfig,
    options: Partial<GeneratorOptions> = {},
    profiles?: ProfileEntry[],
  ): Promise<Drawing2D> {
    return this.generateFromSource(meshArraySource(meshes), config, options, profiles);
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
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = performance.now();
    const signal = opts.signal;
    signal?.throwIfAborted();

    const report = (stage: string, progress: number) => {
      opts.onProgress?.(stage, progress);
    };

    // ─────────────────────────────────────────────────────────────────────────
    // PASS 1: section cutting and construction projection, batch by batch.
    // ─────────────────────────────────────────────────────────────────────────
    report('cutting', 0);

    // GPU path. Falls back to CPU when a custom (face-picked) plane is active
    // because GPUSectionCutter still assumes cardinal axes.
    const gpuCutter = opts.useGPU && this.gpuDevice && !config.plane.customPlane ? this.gpuCutter : null;
    // CPU path. Always rebuild the cutter so a switch from cardinal to
    // custom-plane (or between two custom planes) takes effect immediately.
    const cpuCutter = gpuCutter ? null : new SectionCutter(config.plane);
    if (cpuCutter) this.cpuCutter = cpuCutter;
    const projection = opts.includeProjection
      ? new ProjectionCollector(config, opts, this.edgeExtractor, profiles) : null;
    const segmentBatches: CutSegment[][] = [];
    let totalTriangles = 0;

    for await (const batch of source.pass('geometry')) {
      signal?.throwIfAborted();
      if (gpuCutter) segmentBatches.push(await gpuCutter.cutMeshes([...batch], config.plane));
      else for (const mesh of batch) segmentBatches.push(cpuCutter!.cutSingleMesh(mesh).segments);
      for (const mesh of batch) totalTriangles += mesh.indices.length / 3;
      projection?.add(batch);
    }
    signal?.throwIfAborted();
    const cutSegments = segmentBatches.flat();
    report('cutting', 1);

    if (projection) report('edges', 0);
    const projectionLines = projection?.finish() ?? [];
    if (projection) report('edges', 1);

    // Caller-supplied rim lines (issue #2042) are classifiable like projection
    // lines despite their 'cut' category — see `GeneratorOptions.extraLines`.
    const classifiable = [...(opts.extraLines ?? []), ...projectionLines];
    const classify = (opts.includeHiddenLines || config.clipProjectionBands) && classifiable.length > 0;

    // ─────────────────────────────────────────────────────────────────────────
    // PASS 2 (only when needed): occluder depth raster, and free edges of the
    // entities whose cut left open chains (#8664).
    // ─────────────────────────────────────────────────────────────────────────
    const freeEdges = new OpenSurfaceAccumulator(openSurfaceCandidates(cutSegments));
    const occluderDepth = config.clipProjectionBands
      ? (config.projectionBelowDepth ?? config.projectionDepth)
      : Math.max(config.projectionDepth, config.projectionBelowDepth ?? config.projectionDepth,
        config.projectionAboveDepth ?? config.projectionDepth);
    if (classify) {
      report('hidden', 0);
      // The raster spans every line the drawing will classify or keep.
      this.hiddenLineClassifier.beginDepthBuffer(this.computeBounds(classifiable, cutSegments));
    }
    if (classify || freeEdges.needed) {
      for await (const batch of source.pass('occlusion')) {
        signal?.throwIfAborted();
        freeEdges.add(batch);
        if (!classify) continue;
        const occluders = config.clipProjectionBands
          ? batch.map((mesh) => clipMeshToProjectionWindow(mesh, config.plane, 0, occluderDepth))
            .filter((mesh): mesh is MeshData => mesh !== null)
          : batch;
        this.hiddenLineClassifier.addOccluders(occluders, config.plane, occluderDepth);
      }
      signal?.throwIfAborted();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Polygon reconstruction
    // ─────────────────────────────────────────────────────────────────────────
    report('polygons', 0);
    const openSurfaces = freeEdges.index(), openSurfaceSegments = new Set<CutSegment>();
    const cutPolygons = this.polygonBuilder.buildPolygons(cutSegments, openSurfaces, openSurfaceSegments);
    // Opaque base cross-section per multi-material entity, for the 3D overlay to
    // draw behind the per-layer fills (never see-through). Kept out of
    // `cutPolygons` so the flat 2D drawing / export / measure paths are untouched.
    const layerBaseCutPolygons = this.polygonBuilder.buildBasePolygons(cutSegments, openSurfaces);
    report('polygons', 1);

    const cutLines: DrawingLine[] = cutSegments.map((seg) => ({
      line: { start: seg.p0_2d, end: seg.p1_2d },
      category: 'cut' as LineCategory,
      ...(openSurfaceSegments.has(seg) ? { openSurfaceCut: true as const } : {}),
      visibility: 'visible' as const,
      entityId: seg.entityId,
      ifcType: seg.ifcType,
      modelIndex: seg.modelIndex,
      depth: 0,
    }));

    // ─────────────────────────────────────────────────────────────────────────
    // Hidden line removal
    // ─────────────────────────────────────────────────────────────────────────
    let allLines = [...cutLines, ...classifiable];
    if (classify) {
      // Occlusion only DOWNGRADES visible → hidden; it can never reveal an
      // already-dashed OVERHEAD line. So classify the visible (below-cut)
      // projection lines and pass overhead lines through unchanged — otherwise
      // an unoccluded overhead beam would be re-marked 'visible' (solid).
      //
      // The split is by SOURCE (`classifiable` vs the cutter's own
      // `cutLines`), not by category: `extraLines` carry `category: 'cut'`
      // yet must be classified.
      const toClassify = classifiable.filter((l) => l.visibility === 'visible');
      const passthrough = classifiable.filter((l) => l.visibility !== 'visible');
      const classified = this.hiddenLineClassifier.applyVisibility(toClassify);
      // SDK hidden-output filtering applies to occlusion results. Existing
      // overhead outlines keep their dashed convention even with HLR off.
      const classifiedLines = config.clipProjectionBands && !opts.includeHiddenLines
        ? classified.filter(line => line.visibility !== 'hidden') : classified;
      allLines = [...cutLines, ...classifiedLines, ...passthrough];
      report('hidden', 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Line merging
    // ─────────────────────────────────────────────────────────────────────────
    if (opts.mergeLines) {
      report('merging', 0);
      allLines = mergeDrawingLines(allLines);
      report('merging', 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FINALIZE
    // ─────────────────────────────────────────────────────────────────────────
    const bounds = this.computeBounds(allLines);
    const processingTimeMs = performance.now() - startTime;

    report('complete', 1);

    return {
      config,
      lines: allLines,
      cutPolygons,
      layerBaseCutPolygons,
      projectionPolygons: [], // TODO: implement projection polygon extraction
      bounds,
      stats: {
        cutLineCount: allLines.filter((l) => l.category === 'cut').length,
        projectionLineCount: allLines.filter((l) => l.category === 'projection').length,
        hiddenLineCount: allLines.filter((l) => l.visibility === 'hidden').length,
        silhouetteLineCount: allLines.filter((l) => l.category === 'silhouette').length,
        polygonCount: cutPolygons.length,
        totalTriangles,
        processingTimeMs,
      },
    };
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
   * Compute bounds from lines
   */
  private computeBounds(lines: readonly DrawingLine[], segments: readonly CutSegment[] = []): Bounds2D {
    let bounds = boundsEmpty();
    for (const seg of segments) bounds = boundsExtendLine(bounds, { start: seg.p0_2d, end: seg.p1_2d });
    for (const line of lines) {
      bounds = boundsExtendLine(bounds, line.line);
    }

    return bounds;
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
 * Quick helper to generate a floor plan
 */
export async function generateFloorPlan(
  meshes: MeshData[],
  elevation: number,
  options?: Partial<GeneratorOptions>
): Promise<Drawing2D> {
  const generator = new Drawing2DGenerator();
  try {
    await generator.initialize();

    const config = createSectionConfig('y', elevation, {
      projectionDepth: 3, // 3 meters below cut
      scale: 100,
    });

    return await generator.generate(meshes, config, options);
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
