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
  Drawing2D,
  DrawingLine,
  DrawingPolygon,
  CutSegment,
  Bounds2D,
  LineCategory,
  ProfileEntry,
} from './types.js';
import { DEFAULT_SECTION_CONFIG, makeEntityKey } from './types.js';
import { SectionCutter } from './section-cutter.js';
import { PolygonBuilder } from './polygon-builder.js';
import { EdgeExtractor, getViewDirection } from './edge-extractor.js';
import { HiddenLineClassifier } from './hidden-line.js';
import { mergeDrawingLines, deduplicateLines } from './line-merger.js';
import { HatchGenerator } from './hatch-generator.js';
import { SVGExporter } from './svg-exporter.js';
import type { SVGExportOptions } from './svg-exporter.js';
import { GPUSectionCutter, isGPUComputeAvailable } from './gpu-section-cutter.js';
import { projectProfiles } from './profile-projector.js';
import {
  boundsEmpty,
  boundsExtendPoint,
  boundsExtendLine,
  projectTo2D,
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

    if (opts.useGPU && this.gpuCutter && this.gpuDevice) {
      // GPU path
      cutSegments = await this.gpuCutter.cutMeshes(meshes, config.plane);
    } else {
      // CPU path
      if (!this.cpuCutter || this.cpuCutter === null) {
        this.cpuCutter = new SectionCutter(config.plane);
      }
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
    // STAGE 4: Edge Extraction (Projection Lines)
    // ─────────────────────────────────────────────────────────────────────────
    let projectionLines: DrawingLine[] = [];
    let silhouetteLines: DrawingLine[] = [];

    if (opts.includeProjection || opts.includeEdges) {
      report('edges', 0);

      if (profiles && profiles.length > 0 && opts.includeProjection) {
        // ── Clean path: profile-based projection (no tessellation artifacts) ──
        projectionLines = projectProfiles(profiles, config.plane, config.projectionDepth);
      }

      if (opts.includeEdges) {
        // Feature edges and silhouettes always come from the mesh edge extractor
        // Extract feature edges from all meshes
        const allEdges = this.edgeExtractor.extractEdgesFromMeshes(meshes);

        // Filter edges in projection range
        const projectionEdges = this.edgeExtractor.filterEdgesByDepth(
          allEdges,
          config.plane.axis,
          config.plane.position,
          config.projectionDepth,
          config.plane.flipped
        );

        // Get view direction for silhouette detection
        const viewDir = getViewDirection(config.plane.axis, config.plane.flipped);

        // Extract silhouettes
        const silhouettes = this.edgeExtractor.extractSilhouettes(projectionEdges, viewDir);

        silhouetteLines = this.edgeExtractor.edgesToDrawingLines(
          silhouettes,
          config.plane.axis,
          config.plane.flipped,
          'silhouette',
          config.plane.position
        );

        if (opts.includeProjection) {
          const profileKeys = new Set(
            (profiles ?? []).map((profile) => makeEntityKey(profile.modelIndex, profile.expressId))
          );
          const creaseEdges = projectionEdges.filter((edge) => {
            if (edge.type !== 'crease' || silhouettes.includes(edge)) {
              return false;
            }
            if (profileKeys.size === 0) {
              return true;
            }
            return !profileKeys.has(makeEntityKey(edge.modelIndex, edge.entityId));
          });

          projectionLines = [
            ...projectionLines,
            ...this.edgeExtractor.edgesToDrawingLines(
              creaseEdges,
              config.plane.axis,
              config.plane.flipped,
              'projection',
              config.plane.position
            ),
          ];
        }
      } else if (opts.includeProjection) {
        // No edge extraction requested, but projection is enabled.
        // Use crease-edge fallback for entities not covered by profile extraction.
        const profileKeys = new Set(
          (profiles ?? []).map((profile) => makeEntityKey(profile.modelIndex, profile.expressId))
        );
        const allEdges = this.edgeExtractor.extractEdgesFromMeshes(meshes);
        const projectionEdges = this.edgeExtractor.filterEdgesByDepth(
          allEdges,
          config.plane.axis,
          config.plane.position,
          config.projectionDepth,
          config.plane.flipped
        );
        const creaseEdges = projectionEdges.filter((e) => {
          if (e.type !== 'crease') return false;
          if (profileKeys.size === 0) return true;
          return !profileKeys.has(makeEntityKey(e.modelIndex, e.entityId));
        });
        projectionLines = [
          ...projectionLines,
          ...this.edgeExtractor.edgesToDrawingLines(
            creaseEdges,
            config.plane.axis,
            config.plane.flipped,
            'projection',
            config.plane.position
          ),
        ];
      }

      // Filter out outlier lines that are abnormally long (likely artifacts)
      // Use cut polygon bounds to determine reasonable max line length
      const cutBounds = this.computeBounds(cutLines);
      if (cutBounds.min.x < cutBounds.max.x && cutBounds.min.y < cutBounds.max.y) {
        const boundsWidth = cutBounds.max.x - cutBounds.min.x;
        const boundsHeight = cutBounds.max.y - cutBounds.min.y;
        const boundsDiagonal = Math.sqrt(boundsWidth * boundsWidth + boundsHeight * boundsHeight);
        // Allow lines up to 1.5x the diagonal of the cut area
        const maxLineLength = boundsDiagonal * 1.5;

        silhouetteLines = silhouetteLines.filter((line) => lineLength(line.line) <= maxLineLength);
        projectionLines = projectionLines.filter((line) => lineLength(line.line) <= maxLineLength);
      }

      report('edges', 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 5: Hidden Line Removal
    // ─────────────────────────────────────────────────────────────────────────
    let allLines = [...cutLines, ...projectionLines, ...silhouetteLines];

    if (opts.includeHiddenLines && (projectionLines.length > 0 || silhouetteLines.length > 0)) {
      report('hidden', 0);

      // Compute bounds for depth buffer
      const bounds = this.computeBounds(allLines);

      // Build depth buffer and classify lines
      this.hiddenLineClassifier.buildDepthBuffer(
        meshes,
        config.plane.axis,
        config.plane.position,
        config.projectionDepth,
        config.plane.flipped,
        bounds
      );

      // Only classify non-cut lines
      const linesToClassify = allLines.filter((l) => l.category !== 'cut');
      const classifiedLines = this.hiddenLineClassifier.applyVisibility(linesToClassify);

      // Recombine with cut lines (always visible)
      allLines = [...cutLines, ...classifiedLines];

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
