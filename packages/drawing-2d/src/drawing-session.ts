/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One drawing, fed batch by batch (#10264): the generator's whole algorithm,
 * for callers that lease geometry chunk by chunk and must release each lease
 * before taking the next (caps, plan cuts, view export, the 2D drawing).
 *
 *   const session = generator.beginDrawing(config, options, profiles);
 *   for (chunk of geometry) { await session.addGeometry(lease.meshes); lease.release(); }
 *   const needs = session.endGeometry();
 *   if (needs.depthRaster) for (chunk of geometry) session.addOcclusion(...);
 *   else if (needs.openSurfaceEntities.size) for (chunk of those entities' chunks) session.addOcclusion(...);
 *   const drawing = session.finish();
 *
 * Between batches it keeps only 2D output (cut segments, projection lines),
 * one depth raster and welded edge parity of the open-surface candidates;
 * never a mesh. The occlusion phase must see every mesh of the geometry phase
 * when `depthRaster` is set, and otherwise at least every mesh of each entity
 * in `openSurfaceEntities` (other meshes are ignored). `generate` and
 * `generateFromSource` are drivers over this class, so output is identical.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { CutSegment, Drawing2D, DrawingLine, EntityKey, LineCategory, ProfileEntry, SectionConfig, Bounds2D } from './types.js';
import { SectionCutter } from './section-cutter.js';
import { PolygonBuilder } from './polygon-builder.js';
import { OpenSurfaceAccumulator, openSurfaceCandidates } from './open-surface.js';
import { EdgeExtractor } from './edge-extractor.js';
import { HiddenLineClassifier } from './hidden-line.js';
import { mergeDrawingLines } from './line-merger.js';
import type { GPUSectionCutter } from './gpu-section-cutter.js';
import { clipMeshToProjectionWindow } from './projection-clip.js';
import { ProjectionCollector, type ProjectionCollectorOptions } from './projection-collector.js';
import { boundsEmpty, boundsExtendLine } from './math.js';

export interface DrawingSessionOptions extends ProjectionCollectorOptions {
  useGPU: boolean;
  includeHiddenLines: boolean;
  includeProjection: boolean;
  mergeLines: boolean;
  extraLines?: DrawingLine[];
  onProgress?: (stage: string, progress: number) => void;
  signal?: AbortSignal;
}

/** What the occlusion phase must be fed, known once the geometry phase ends. */
export interface DrawingOcclusionNeeds {
  /** Hidden-line raster: feed every mesh of the geometry phase again. */
  readonly depthRaster: boolean;
  /** Entities whose cut left open chains (#8664): feed all of their meshes. */
  readonly openSurfaceEntities: ReadonlySet<EntityKey>;
}

type Phase = 'geometry' | 'occlusion' | 'done' | 'cancelled';

/** Bounds over lines and raw cut segments. */
export function drawingBounds(lines: readonly DrawingLine[], segments: readonly CutSegment[] = []): Bounds2D {
  let bounds = boundsEmpty();
  for (const seg of segments) bounds = boundsExtendLine(bounds, { start: seg.p0_2d, end: seg.p1_2d });
  for (const line of lines) bounds = boundsExtendLine(bounds, line.line);
  return bounds;
}

export class DrawingSession {
  private phase: Phase = 'geometry';
  private readonly startTime = performance.now();
  private readonly cpuCutter: SectionCutter | null;
  private readonly projection: ProjectionCollector | null;
  private readonly segmentBatches: CutSegment[][] = [];
  private readonly hiddenLines = new HiddenLineClassifier({ resolution: 1024 });
  private readonly polygonBuilder = new PolygonBuilder();
  private totalTriangles = 0;
  private cutSegments: CutSegment[] = [];
  private classifiable: DrawingLine[] = [];
  private classify = false;
  private freeEdges: OpenSurfaceAccumulator | null = null;
  private readonly occluderDepth: number;

  constructor(
    private readonly config: SectionConfig,
    private readonly opts: DrawingSessionOptions,
    profiles: readonly ProfileEntry[] | undefined,
    /** Cardinal planes only; null for the CPU cutter. */
    private readonly gpuCutter: GPUSectionCutter | null,
  ) {
    opts.signal?.throwIfAborted();
    // CPU cutter per drawing, so a switch between planes always takes effect.
    this.cpuCutter = gpuCutter ? null : new SectionCutter(config.plane);
    this.projection = opts.includeProjection
      ? new ProjectionCollector(config, opts, new EdgeExtractor(30), profiles) : null;
    this.occluderDepth = config.clipProjectionBands
      ? (config.projectionBelowDepth ?? config.projectionDepth)
      : Math.max(config.projectionDepth, config.projectionBelowDepth ?? config.projectionDepth,
        config.projectionAboveDepth ?? config.projectionDepth);
    this.report('cutting', 0);
  }

  private report(stage: string, progress: number): void {
    this.opts.onProgress?.(stage, progress);
  }

  private enter(expected: Phase): void {
    if (this.phase !== expected) throw new Error(`Drawing session is in its ${this.phase} phase, not ${expected}`);
    this.opts.signal?.throwIfAborted();
  }

  /** Cut and project one batch; keeps no reference to it. */
  async addGeometry(meshes: readonly MeshData[]): Promise<void> {
    this.enter('geometry');
    if (this.gpuCutter) this.segmentBatches.push(await this.gpuCutter.cutMeshes([...meshes], this.config.plane));
    else for (const mesh of meshes) this.segmentBatches.push(this.cpuCutter!.cutSingleMesh(mesh).segments);
    this.opts.signal?.throwIfAborted();
    for (const mesh of meshes) this.totalTriangles += mesh.indices.length / 3;
    this.projection?.add(meshes);
  }

  /** End the geometry phase; says what the occlusion phase needs, if anything. */
  endGeometry(): DrawingOcclusionNeeds {
    this.enter('geometry');
    this.phase = 'occlusion';
    const { config, opts } = this;
    this.cutSegments = this.segmentBatches.flat();
    this.segmentBatches.length = 0;
    this.report('cutting', 1);

    if (this.projection) this.report('edges', 0);
    const projectionLines = this.projection?.finish() ?? [];
    if (this.projection) this.report('edges', 1);

    // Caller-supplied rim lines (issue #2042) are classifiable like projection
    // lines despite their 'cut' category — see `GeneratorOptions.extraLines`.
    this.classifiable = [...(opts.extraLines ?? []), ...projectionLines];
    this.classify = (opts.includeHiddenLines || !!config.clipProjectionBands) && this.classifiable.length > 0;
    const candidates = openSurfaceCandidates(this.cutSegments);
    this.freeEdges = new OpenSurfaceAccumulator(candidates);
    if (this.classify) {
      this.report('hidden', 0);
      // The raster spans every line the drawing will classify or keep.
      this.hiddenLines.beginDepthBuffer(drawingBounds(this.classifiable, this.cutSegments));
    }
    return { depthRaster: this.classify, openSurfaceEntities: candidates };
  }

  /** Feed one batch of the occlusion phase (see {@link DrawingOcclusionNeeds}). */
  addOcclusion(meshes: readonly MeshData[]): void {
    this.enter('occlusion');
    const { config, occluderDepth } = this;
    this.freeEdges!.add(meshes);
    if (!this.classify) return;
    const occluders = config.clipProjectionBands
      ? meshes.map((mesh) => clipMeshToProjectionWindow(mesh, config.plane, 0, occluderDepth))
        .filter((mesh): mesh is MeshData => mesh !== null)
      : meshes;
    this.hiddenLines.addOccluders(occluders, config.plane, occluderDepth);
  }

  /** Abandon the drawing; every later call throws. */
  cancel(): void {
    this.phase = 'cancelled';
    this.segmentBatches.length = 0;
    this.cutSegments = [];
    this.classifiable = [];
    this.freeEdges = null;
  }

  /** Polygons, occlusion, merging: the finished drawing. */
  finish(): Drawing2D {
    if (this.phase === 'geometry') this.endGeometry();
    this.enter('occlusion');
    this.phase = 'done';
    const { config, opts, cutSegments, classifiable } = this;
    // ─────────────────────────────────────────────────────────────────────────
    // Polygon reconstruction
    // ─────────────────────────────────────────────────────────────────────────
    this.report('polygons', 0);
    const openSurfaces = this.freeEdges!.index(), openSurfaceSegments = new Set<CutSegment>();
    const cutPolygons = this.polygonBuilder.buildPolygons(cutSegments, openSurfaces, openSurfaceSegments);
    // Opaque base cross-section per multi-material entity, for the 3D overlay to
    // draw behind the per-layer fills (never see-through). Kept out of
    // `cutPolygons` so the flat 2D drawing / export / measure paths are untouched.
    const layerBaseCutPolygons = this.polygonBuilder.buildBasePolygons(cutSegments, openSurfaces);
    this.report('polygons', 1);

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
    if (this.classify) {
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
      const classified = this.hiddenLines.applyVisibility(toClassify);
      // SDK hidden-output filtering applies to occlusion results. Existing
      // overhead outlines keep their dashed convention even with HLR off.
      const classifiedLines = config.clipProjectionBands && !opts.includeHiddenLines
        ? classified.filter(line => line.visibility !== 'hidden') : classified;
      allLines = [...cutLines, ...classifiedLines, ...passthrough];
      this.report('hidden', 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Line merging
    // ─────────────────────────────────────────────────────────────────────────
    if (opts.mergeLines) {
      this.report('merging', 0);
      allLines = mergeDrawingLines(allLines);
      this.report('merging', 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FINALIZE
    // ─────────────────────────────────────────────────────────────────────────
    const bounds = drawingBounds(allLines);
    const processingTimeMs = performance.now() - this.startTime;

    this.report('complete', 1);

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
        totalTriangles: this.totalTriangles,
        processingTimeMs,
      },
    };
  }
}
