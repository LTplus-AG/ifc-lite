/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export what the 3D viewport currently shows as a to-scale vector PDF (#2042).
 *
 * DEFECT CLASS 1 — a page that is dimensionally exact and geometrically wrong.
 * Every coordinate on the sheet passes through exactly two transforms: the
 * camera basis (`buildCameraSectionPlane` + `projectPointForPlane`, which
 * yields screen-right / screen-up metres) and `worldPointToPdfMm` (which
 * applies the paper Y flip and nothing else). There is deliberately NO third
 * flip here: `axisFlipForSection` exists for cardinal SECTION exports, whose 2D
 * frame is chosen per cut axis, and applying it to a camera-basis drawing
 * mirrors the page while every measured distance stays correct — the #2119
 * showstopper class, invisible to any test that only measures lengths.
 *
 * DEFECT CLASS 2 — an async export that fails silently. The jsPDF import is
 * dynamic (a code-split chunk), so on a stale deploy it rejects. This function
 * returns a promise that REJECTS with a real message; it never fires and
 * forgets. Callers must await it or attach a rejection handler, or a failed
 * chunk load becomes an unhandled rejection with nothing on screen.
 *
 * Everything the export reads from the outside world is an injectable seam —
 * the camera snapshot, the instanced-mesh supplier, the document factory and
 * the download sink — so the whole pipeline runs under `node:test` with no
 * WebGPU device, no renderer and no jsPDF.
 */

import {
  Drawing2DGenerator,
  buildCameraSectionPlane,
  clipMeshesToHalfSpace,
  computePdfScaleLayout,
  createSectionConfig,
  formatScaleFactorLabel,
  projectWorldLineSeeds,
  worldBoundsOfMeshes,
  worldPointToPdfMm,
  type CameraFrame,
  type Drawing2D,
  type DrawingLine,
  type PdfPage,
  type PdfScaleTransform,
  type Point2D,
  type SectionConfig,
  type WorldBounds3D,
  type WorldLineSeed,
} from '@ifc-lite/drawing-2d';
import type { MeshData } from '@ifc-lite/geometry';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import { pdfLineStyleFor } from '@/lib/export/pdf-line-style';
import { collectViewMeshes, type ViewMeshInput } from './collect-view-meshes';
import { VIEW_PDF_MARGIN_MM } from './view-pdf-page-estimate';
import { resolveKeptHalfSpace, type ViewSectionResolveInput } from './view-section-plane';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC SHAPES
// ═══════════════════════════════════════════════════════════════════════════

/** Everything the export needs from the live camera, as plain numbers. */
export interface ViewCameraSnapshot extends CameraFrame {
  projectionMode: 'orthographic' | 'perspective';
}

export interface ViewPdfExportInput {
  /** Visibility channels + the flat and instanced mesh halves (#2558). */
  view: ViewMeshInput;
  camera: ViewCameraSnapshot;
  /**
   * The active cut, or `null` for "no section". Present means the CPU clip
   * runs and the rim prints as heavy cut lines.
   */
  section: ViewSectionResolveInput | null;
  /** The "N" in 1:N. Exact — never rounded on its way to the page. */
  scaleFactor: number;
  /** Blank paper around the drawing, mm per side. */
  marginMm?: number;
  /** Draw occluded line work dashed (`true`) or drop it (`false`). */
  includeHiddenLines?: boolean;
  onProgress?: (stage: string, progress: number) => void;
}

/** What actually got written, for the success toast and analytics. */
export interface ViewPdfExportResult {
  page: PdfPage;
  filename: string;
  /** Strokes emitted. Zero means an empty sheet, which the caller should report. */
  strokeCount: number;
}

/** The slice of jsPDF this writer uses, so a test can stand in for it. */
export interface ViewPdfDocument {
  setDrawColor(r: number, g: number, b: number): void;
  setLineCap(style: string): void;
  setLineWidth(width: number): void;
  setLineDashPattern(pattern: number[], phase: number): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  output(type: 'blob'): Blob;
}

export interface ViewPdfDeps {
  /** Build an empty document of exactly `page` millimetres. */
  createDocument?: (page: PdfPage) => Promise<ViewPdfDocument>;
  /** Save the finished bytes. Defaults to the canonical `downloadFile`. */
  download?: (blob: Blob, filename: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Depth of the "everything is solid" band in front of the camera plane. The
 * projection classifier reads `below` as the kept window and `above` as the
 * sliver on the far side of the plane; a synthetic plane placed in front of
 * the whole model therefore wants the full view depth below and (almost)
 * nothing above, which is the same trick the plan-view drawing uses to mean
 * "project everything behind the plane, solid".
 */
const ABOVE_PLANE_DEPTH_M = 1e-3;

export async function generateViewPdf(
  input: ViewPdfExportInput,
  deps: ViewPdfDeps = {},
): Promise<ViewPdfExportResult> {
  const marginMm = input.marginMm ?? VIEW_PDF_MARGIN_MM;
  const meshes = collectViewMeshes(input.view);
  if (meshes.length === 0) {
    throw new Error('Nothing to export: no geometry is visible in the current view.');
  }

  // ── 1. Apply the section cut on the CPU ─────────────────────────────────
  // The on-screen cut is a fragment discard; a vector drawing has no fragment
  // stage, so the triangles themselves have to be clipped or the PDF shows a
  // whole model the screen is showing halved.
  let drawnMeshes: MeshData[] = meshes;
  let extraLines: DrawingLine[] = [];
  // `WorldSegment` already IS a `WorldLineSeed` (start/end plus the source
  // element), so the rim goes straight into the projector with no re-shaping —
  // one fewer place for a field to be dropped on the way.
  let rimSeeds: WorldLineSeed[] = [];
  if (input.section) {
    const half = resolveKeptHalfSpace(input.section);
    const clipped = clipMeshesToHalfSpace(meshes, half.normal, half.offset);
    drawnMeshes = clipped.meshes;
    rimSeeds = clipped.rimSegments;
    if (drawnMeshes.length === 0) {
      throw new Error('Nothing to export: the section cut removes all visible geometry.');
    }
  }

  // ── 2. Synthetic camera plane ───────────────────────────────────────────
  const worldBounds: WorldBounds3D | null = worldBoundsOfMeshes(drawnMeshes);
  if (!worldBounds) {
    throw new Error('Nothing to export: the visible geometry has no usable coordinates.');
  }
  const { plane, viewDepth } = buildCameraSectionPlane(input.camera, worldBounds);

  // Rim segments are world-space, so they project through the SAME plane the
  // meshes do and carry real view depths — which is what lets the hidden-line
  // pass dash the far side of a cut object on an oblique view.
  if (rimSeeds.length > 0) {
    extraLines = projectWorldLineSeeds(rimSeeds, plane);
  }

  const config: SectionConfig = createSectionConfig(plane.axis, plane.position, {
    projectionDepth: viewDepth,
    projectionBelowDepth: viewDepth,
    projectionAboveDepth: ABOVE_PLANE_DEPTH_M,
    // ALWAYS classify, whatever the user asked for. See the note at the
    // `writeDrawing` call: "off" must mean omitted, not undetected.
    includeHiddenLines: true,
    scale: input.scaleFactor,
  });
  config.plane = plane;

  // ── 3. Line work ────────────────────────────────────────────────────────
  const generator = new Drawing2DGenerator();
  let drawing: Drawing2D;
  try {
    // No GPU device is passed, so `useGPU` has nothing to select even before
    // the custom plane forces the CPU cutter. Stated explicitly so a future
    // GPU-capable caller cannot silently take the cardinal-only path.
    await generator.initialize();
    drawing = await generator.generate(drawnMeshes, config, {
      useGPU: false,
      includeHiddenLines: true,
      includeProjection: true,
      includeEdges: true,
      mergeLines: true,
      extraLines,
      onProgress: input.onProgress,
    });
  } finally {
    generator.dispose();
  }

  // ── 4. Page + write ─────────────────────────────────────────────────────
  // IDENTITY flip: the camera basis already delivers x-right / y-up, and
  // `worldPointToPdfMm` supplies the one paper Y flip. See the module docblock.
  const layout = computePdfScaleLayout(drawing.bounds, input.scaleFactor, marginMm);
  const doc = await (deps.createDocument ?? createJsPdfDocument)(layout.page);
  // The ONLY place the "show hidden edges" choice is honoured. Classification
  // above always runs, because skipping it does not remove occluded edges - it
  // leaves them unclassified, so they print as SOLID lines indistinguishable
  // from geometry the viewer can actually see. That is strictly worse than the
  // dashes the user turned off: an engineer measuring the sheet cannot tell
  // the phantom edge from a real one. Classify always, draw selectively.
  const strokeCount = writeDrawing(doc, drawing.lines, layout.transform, {
    includeHiddenLines: input.includeHiddenLines ?? true,
  });

  // The filename is the sole record of the sheet's scale (v1 has no title
  // block), so it carries the EXACT factor: rounding here would file a 1:99.5
  // export as "1-100" and misreport what the page can be measured at (#2119).
  const filename = `${sanitizeFilename(
    `3d-view-1-${formatScaleFactorLabel(input.scaleFactor)}`,
    { fallback: '3d-view' },
  )}.pdf`;
  (deps.download ?? defaultDownload)(doc.output('blob'), filename);

  return { page: layout.page, filename, strokeCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// WRITING
// ═══════════════════════════════════════════════════════════════════════════

function writeDrawing(
  doc: ViewPdfDocument,
  lines: readonly DrawingLine[],
  transform: PdfScaleTransform,
  options: { includeHiddenLines: boolean },
): number {
  doc.setDrawColor(0, 0, 0);
  doc.setLineCap('round');

  let strokeCount = 0;
  for (const line of lines) {
    if (!options.includeHiddenLines && line.visibility === 'hidden') continue;

    const { start, end } = line.line;
    if (
      !Number.isFinite(start.x) || !Number.isFinite(start.y) ||
      !Number.isFinite(end.x) || !Number.isFinite(end.y)
    ) {
      continue;
    }

    // Shared with the section PDF so the two writers cannot drift into two
    // different line hierarchies for the same model.
    const { lineWidthMm, dash } = pdfLineStyleFor(line.category, line.visibility);
    const p0: Point2D = worldPointToPdfMm(start, transform);
    const p1: Point2D = worldPointToPdfMm(end, transform);
    doc.setLineWidth(lineWidthMm);
    doc.setLineDashPattern(dash, 0);
    doc.line(p0.x, p0.y, p1.x, p1.y);
    strokeCount++;
  }
  doc.setLineDashPattern([], 0);
  return strokeCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT SEAMS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * jsPDF, loaded as its own chunk. Wrapped in a plain object rather than handed
 * over directly so this module depends on the four calls it makes and not on
 * jsPDF's full (and overloaded) surface.
 */
async function createJsPdfDocument(page: PdfPage): Promise<ViewPdfDocument> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({
    unit: 'mm',
    format: [page.widthMm, page.heightMm],
    orientation: page.widthMm >= page.heightMm ? 'landscape' : 'portrait',
  });
  return {
    setDrawColor: (r, g, b) => { doc.setDrawColor(r, g, b); },
    setLineCap: (style) => { doc.setLineCap(style); },
    setLineWidth: (width) => { doc.setLineWidth(width); },
    setLineDashPattern: (pattern, phase) => { doc.setLineDashPattern(pattern, phase); },
    line: (x1, y1, x2, y2) => { doc.line(x1, y1, x2, y2); },
    output: (type) => doc.output(type),
  };
}

/** The one sanctioned save path — never a hand-rolled `<a download>`. */
function defaultDownload(blob: Blob, filename: string): void {
  downloadFile(blob, filename, 'application/pdf');
}
