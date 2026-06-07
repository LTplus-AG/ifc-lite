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
  SectionPlaneConfig,
  SectionAxis,
  Drawing2D,
  DrawingLine,
  DrawingPolygon,
  CutSegment,
  Bounds2D,
  LineCategory,
  ProfileEntry,
  EntityKey,
  MeshOutline2D,
} from './types.js';
import { DEFAULT_SECTION_CONFIG, makeEntityKey } from './types.js';
import { SectionCutter } from './section-cutter.js';
import { PolygonBuilder } from './polygon-builder.js';
import { EdgeExtractor } from './edge-extractor.js';
import { HiddenLineClassifier } from './hidden-line.js';
import { mergeDrawingLines } from './line-merger.js';
import { HatchGenerator } from './hatch-generator.js';
import { SVGExporter } from './svg-exporter.js';
import type { SVGExportOptions } from './svg-exporter.js';
import { GPUSectionCutter } from './gpu-section-cutter.js';
import { projectProfiles } from './profile-projector.js';
import {
  type ProjectionBandDepths,
  getViewDirectionForPlane,
  outlineToProjectionLines,
} from './projection-bands.js';
import {
  boundsEmpty,
  boundsExtendPoint,
  boundsExtendLine,
  lineLength,
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
   */
  outlineProvider?: (mesh: MeshData, axis: SectionAxis, flipped: boolean) => MeshOutline2D | null;
  /** Progress callback */
  onProgress?: (stage: string, progress: number) => void;
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
   * Generate a complete 2D drawing from meshes
   */
  async generate(
    meshes: MeshData[],
    config: SectionConfig,
    options: Partial<GeneratorOptions> = {},
    profiles?: ProfileEntry[],
  ): Promise<Drawing2D> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = performance.now();

    const report = (stage: string, progress: number) => {
      opts.onProgress?.(stage, progress);
    };

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: Section Cutting
    // ─────────────────────────────────────────────────────────────────────────
    report('cutting', 0);

    let cutSegments: CutSegment[];

    if (opts.useGPU && this.gpuCutter && this.gpuDevice && !config.plane.customPlane) {
      // GPU path. Falls back to CPU when a custom (face-picked) plane is
      // active because GPUSectionCutter still assumes cardinal axes —
      // generalising the GPU path is tracked as follow-up work; for now
      // CPU is fast enough on the FZK-Haus-class models the face-pick
      // UX targets.
      cutSegments = await this.gpuCutter.cutMeshes(meshes, config.plane);
    } else {
      // CPU path. Always rebuild the cutter so a switch from cardinal
      // to custom-plane (or between two different custom planes) takes
      // effect immediately — caching the instance keyed only on
      // existence, as the previous code did, would silently apply the
      // first config used for the lifetime of the generator.
      this.cpuCutter = new SectionCutter(config.plane);
      const cutResult = this.cpuCutter.cutMeshes(meshes);
      cutSegments = cutResult.segments;
    }

    report('cutting', 1);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: Polygon Reconstruction
    // ─────────────────────────────────────────────────────────────────────────
    report('polygons', 0);

    const cutPolygons = this.polygonBuilder.buildPolygons(cutSegments);

    report('polygons', 1);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: Convert Cut Segments to Drawing Lines
    // ─────────────────────────────────────────────────────────────────────────
    const cutLines: DrawingLine[] = cutSegments.map((seg) => ({
      line: { start: seg.p0_2d, end: seg.p1_2d },
      category: 'cut' as LineCategory,
      visibility: 'visible' as const,
      entityId: seg.entityId,
      ifcType: seg.ifcType,
      modelIndex: seg.modelIndex,
      depth: 0,
    }));

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 4: Construction Projection Lines (issue #979)
    //
    // Project geometry BEYOND the cut into two architectural bands:
    //   • below the cut → VISIBLE  (thin solid)
    //   • above the cut → OVERHEAD (dashed, carried as `visibility:'hidden'`)
    //
    // Sources, picked per element to avoid double-drawing the same wall:
    //   • extruded-area solids → clean profile boundaries (`projectProfiles`)
    //   • everything else      → mesh SILHOUETTE outline (NOT crease edges,
    //     which draw every tessellation facet). Runs only when `includeEdges`.
    // ─────────────────────────────────────────────────────────────────────────
    let projectionLines: DrawingLine[] = [];

    if (opts.includeProjection) {
      report('edges', 0);

      const bands: ProjectionBandDepths = {
        below: config.projectionBelowDepth ?? config.projectionDepth,
        above: config.projectionAboveDepth ?? config.projectionDepth,
      };

      // Per-element dedup: elements with an extracted profile take their
      // projection from the clean profile path only; the silhouette fallback
      // skips them.
      const coveredKeys = new Set<EntityKey>();
      if (profiles && profiles.length > 0) {
        for (const profile of profiles) {
          coveredKeys.add(makeEntityKey(profile.modelIndex, profile.expressId));
        }
        projectionLines.push(...projectProfiles(profiles, config.plane, bands));
      }

      if (opts.includeEdges) {
        // Outline for non-extruded geometry (roofs, stairs, site, BReps) with
        // no extracted profile — the elements issue #979 specifically calls
        // out. Prefer the winding-robust Rust `meshOutline2d` footprint when an
        // outlineProvider is supplied; fall back per-mesh to the normal-based
        // silhouette (which can break on ifc-lite's unreliable winding).
        const meshesForSilhouette =
          coveredKeys.size > 0
            ? meshes.filter(
                (m) => !coveredKeys.has(makeEntityKey(m.modelIndex ?? 0, m.expressId)),
              )
            : meshes;

        const viewDir = getViewDirectionForPlane(config.plane);
        for (const mesh of meshesForSilhouette) {
          const outline = opts.outlineProvider
            ? opts.outlineProvider(mesh, config.plane.axis, config.plane.flipped)
            : null;
          if (outline && outline.contours.length > 0) {
            projectionLines.push(
              ...outlineToProjectionLines(
                outline,
                {
                  entityId: mesh.expressId,
                  ifcType: mesh.ifcType ?? 'Unknown',
                  modelIndex: mesh.modelIndex ?? 0,
                },
                config.plane,
                bands,
              ),
            );
          } else {
            const edges = this.edgeExtractor.extractEdges(mesh);
            const silhouettes = this.edgeExtractor.extractSilhouettes(edges, viewDir);
            projectionLines.push(
              ...this.edgeExtractor.edgesToProjectionLines(silhouettes, config.plane, bands),
            );
          }
        }
      }

      // Drop outlier lines abnormally longer than the cut area (artifacts).
      const cutBounds = this.computeBounds(cutLines);
      if (cutBounds.min.x < cutBounds.max.x && cutBounds.min.y < cutBounds.max.y) {
        const boundsWidth = cutBounds.max.x - cutBounds.min.x;
        const boundsHeight = cutBounds.max.y - cutBounds.min.y;
        const boundsDiagonal = Math.sqrt(boundsWidth * boundsWidth + boundsHeight * boundsHeight);
        // Allow lines up to 1.5x the diagonal of the cut area
        const maxLineLength = boundsDiagonal * 1.5;
        projectionLines = projectionLines.filter((line) => lineLength(line.line) <= maxLineLength);
      }

      report('edges', 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 5: Hidden Line Removal
    // ─────────────────────────────────────────────────────────────────────────
    let allLines = [...cutLines, ...projectionLines];

    if (opts.includeHiddenLines && projectionLines.length > 0) {
      report('hidden', 0);

      // Compute bounds for depth buffer
      const bounds = this.computeBounds(allLines);

      // The depth buffer must cover everything projection can emit — including
      // the (possibly wider) construction-projection bands — or in-band lines
      // beyond projectionDepth would be classified against an incomplete buffer
      // and wrongly stay visible because their occluders were never rasterized.
      const occluderDepth = Math.max(
        config.projectionDepth,
        config.projectionBelowDepth ?? config.projectionDepth,
        config.projectionAboveDepth ?? config.projectionDepth,
      );

      // Build depth buffer and classify lines
      this.hiddenLineClassifier.buildDepthBuffer(
        meshes,
        config.plane.axis,
        config.plane.position,
        occluderDepth,
        config.plane.flipped,
        bounds
      );

      // Occlusion only DOWNGRADES visible → hidden; it can never reveal an
      // already-dashed OVERHEAD line. So classify the visible (below-cut)
      // projection lines and pass overhead lines through unchanged — otherwise
      // an unoccluded overhead beam would be re-marked 'visible' (solid).
      const toClassify = allLines.filter((l) => l.category !== 'cut' && l.visibility === 'visible');
      const passthrough = allLines.filter((l) => l.category !== 'cut' && l.visibility !== 'visible');
      const classifiedLines = this.hiddenLineClassifier.applyVisibility(toClassify);

      // Recombine with cut lines (always visible) + overhead pass-through.
      allLines = [...cutLines, ...classifiedLines, ...passthrough];

      report('hidden', 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 6: Line Merging
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

    // Count line categories
    const cutLineCount = allLines.filter((l) => l.category === 'cut').length;
    const projectionLineCount = allLines.filter((l) => l.category === 'projection').length;
    const hiddenLineCount = allLines.filter((l) => l.visibility === 'hidden').length;
    const silhouetteLineCount = allLines.filter((l) => l.category === 'silhouette').length;

    report('complete', 1);

    return {
      config,
      lines: allLines,
      cutPolygons,
      projectionPolygons: [], // TODO: implement projection polygon extraction
      bounds,
      stats: {
        cutLineCount,
        projectionLineCount,
        hiddenLineCount,
        silhouetteLineCount,
        polygonCount: cutPolygons.length,
        totalTriangles: meshes.reduce((sum, m) => sum + m.indices.length / 3, 0),
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
  private computeBounds(lines: DrawingLine[]): Bounds2D {
    let bounds = boundsEmpty();

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
