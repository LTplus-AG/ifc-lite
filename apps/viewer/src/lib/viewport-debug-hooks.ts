/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { appearanceSourceTriangle, MathUtils, type Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { getPointCloudScanSample } from '@/hooks/ingest/pointCloudScanCache';
import { activeVisibilityReasons } from '@/lib/visibility/visibility-reasons';
import { useViewerStore } from '@/store';

/** One resident part of an owner as plain data: no buffers, no live objects. */
export interface ScenePartSnapshot {
  geometryItemId: number | undefined;
  triangles: number;
  vertices: number;
  textured: boolean;
  color: [number, number, number, number];
  /** Canonical evaluated-surface ordinals still carried by this part. */
  sourceTriangles: number[];
}
export interface SceneFaceHitSnapshot {
  geometryItemId: number | undefined;
  sourceTriangleIndex: number;
  screen: { x: number; y: number };
}
/** What the scene currently renders for one federation-resolved id. */
export interface SceneOwnerSnapshot {
  /** Flat (resident) parts, `null` when the owner has none. */
  flat: ScenePartSnapshot[] | null;
  /** Whether the owner is currently drawn as a GPU instance. */
  instance: boolean;
  /** Placed corner positions of the flat parts, or of the instance, for exact comparisons across steps. */
  corners: number[];
  /** Client-space centre of the owner's bounds, where a viewport click would land; `null` off screen. */
  screen: { x: number; y: number } | null;
}

/** The streamed points after the exact matrix the point renderer applies. */
export interface RenderedPointCloudSnapshot {
  pointCount: number;
  points: Array<[number, number, number]>;
}

/** The current hide/isolation sets passed to the renderer, including storey filtering. */
export interface RenderVisibilitySnapshot {
  hiddenIds: number[];
  isolatedIds: number[] | null;
}

async function encodeColorFrame(framePromise: ReturnType<Renderer['captureColorFrame']>): Promise<string | null> {
  const frame = await framePromise;
  if (!frame) return null;
  try {
    const canvas = new OffscreenCanvas(frame.width, frame.height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    // ImageData requires ArrayBuffer-backed bytes; readback's public surface
    // permits ArrayBufferLike, so make a short-lived owned copy at this E2E
    // boundary rather than leaking a SharedArrayBuffer assumption into it.
    context.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return `data:image/png;base64,${btoa(binary)}`;
  } catch (error) {
    console.warn('[Viewport] Color-frame debug encoding failed:', error);
    return null;
  }
}

/** A diagnostic must never copy an unbounded retained scan into page state. */
const RENDERED_POINT_CLOUD_DEBUG_LIMIT = 16;

function snapshot(part: MeshData): ScenePartSnapshot {
  const sourceTriangles: number[] = [];
  for (let triangle = 0; triangle < part.indices.length / 3; triangle++) {
    const source = appearanceSourceTriangle(part, triangle);
    if (source !== undefined) sourceTriangles.push(source);
  }
  return { geometryItemId: part.geometryItemId, triangles: part.indices.length / 3, vertices: part.positions.length / 3,
    textured: !!(part.uvs && (part.texture || (part.textureRef && part.textureBitmap))), color: [...part.color] as ScenePartSnapshot['color'], sourceTriangles };
}

/**
 * Read-only debug/e2e hooks on `globalThis`, the same convention as
 * `__ifc_lite_viewer_store__`: live frame stats, resident GPU/CPU bytes and a
 * per-owner scene snapshot for Playwright assertions and console inspection.
 * Installed by the viewport when its renderer is ready, cleared on teardown.
 */
export function installViewportDebugHooks(
  renderer: Renderer,
  visibility: () => { hiddenIds: ReadonlySet<number>; isolatedIds: ReadonlySet<number> | null },
  annotationLineVertexCount: () => number,
): void {
  const host = globalThis as Record<string, unknown>;
  host.__ifc_lite_render_stats__ = () => ({
    frame: renderer.getFrameStats(),
    gpu: renderer.getScene().getResidentGpuBytes(),
    cpuBytes: renderer.getScene().getResidentCpuBytes(),
  });
  // Renderer-owned color evidence for hardware E2E. The RGBA bytes are copied
  // before the production frame submits, so this avoids compositor retention
  // and exposes no scene/model data to the browser test.
  host.__ifc_lite_capture_color_frame__ = () => encodeColorFrame(renderer.captureColorFrame());
  host.__ifc_lite_render_visibility__ = (): RenderVisibilitySnapshot => {
    const current = visibility();
    return { hiddenIds: [...current.hiddenIds], isolatedIds: current.isolatedIds ? [...current.isolatedIds] : null };
  };
  host.__ifc_lite_annotation_line_vertices__ = annotationLineVertexCount;
  host.__ifc_lite_visibility_reasons__ = () => activeVisibilityReasons(useViewerStore.getState())
    .map(({ id, resetPolicy }) => ({ id, resetPolicy }));
  host.__ifc_lite_scene_owner__ = (globalId: number): SceneOwnerSnapshot => {
    const scene = renderer.getScene();
    const flat = scene.getMeshDataPieces(globalId), instanced = scene.getInstancedMeshDataPieces(globalId);
    const corners: number[] = [];
    for (const part of flat ?? instanced ?? []) for (let corner = 0; corner < part.indices.length; corner++) {
      for (let axis = 0; axis < 3; axis++) corners.push(part.positions[part.indices[corner] * 3 + axis] + (part.origin?.[axis] ?? 0));
    }
    const box = scene.getEntityBoundingBox(globalId) ?? scene.getInstancedEntityBounds(globalId);
    const rect = renderer.getCanvas().getBoundingClientRect();
    const centre = box && renderer.getCamera().projectToScreen({ x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 }, rect.width, rect.height);
    return { flat: flat?.map(snapshot) ?? null, instance: !!instanced, corners, screen: centre ? { x: rect.left + centre.x, y: rect.top + centre.y } : null };
  };
  host.__ifc_lite_scene_face_hits__ = (globalId: number): SceneFaceHitSnapshot[] => {
    const scene = renderer.getScene(), rect = renderer.getCanvas().getBoundingClientRect();
    const parts = scene.getMeshDataPieces(globalId) ?? scene.getInstancedMeshDataPieces(globalId) ?? [];
    const hits = new Map<number, SceneFaceHitSnapshot>();
    for (const part of parts) for (let triangle = 0; triangle < part.indices.length / 3; triangle++) {
      const sourceTriangleIndex = appearanceSourceTriangle(part, triangle);
      if (sourceTriangleIndex === undefined || hits.has(sourceTriangleIndex)) continue;
      const point = { x: 0, y: 0, z: 0 };
      for (let corner = 0; corner < 3; corner++) {
        const vertex = part.indices[triangle * 3 + corner];
        point.x += (part.positions[vertex * 3] + (part.origin?.[0] ?? 0)) / 3;
        point.y += (part.positions[vertex * 3 + 1] + (part.origin?.[1] ?? 0)) / 3;
        point.z += (part.positions[vertex * 3 + 2] + (part.origin?.[2] ?? 0)) / 3;
      }
      const screen = renderer.getCamera().projectToScreen(point, rect.width, rect.height);
      if (!screen) continue;
      const state = useViewerStore.getState();
      const exact = renderer.raycastScene(screen.x, screen.y, {
        hiddenIds: state.hiddenEntities, isolatedIds: state.isolatedEntities,
      })?.intersection;
      if (exact?.expressId !== globalId || exact.sourceTriangleIndex !== sourceTriangleIndex
        || exact.geometryItemId !== part.geometryItemId) continue;
      hits.set(sourceTriangleIndex, { geometryItemId: part.geometryItemId, sourceTriangleIndex,
        screen: { x: rect.left + screen.x, y: rect.top + screen.y } });
    }
    return [...hits.values()].sort((a, b) => a.sourceTriangleIndex - b.sourceTriangleIndex);
  };
  // Streamed point data is GPU-resident, while the bounded cache retains the
  // same post-Y-up decode points for product features such as scan sections.
  // This read-only diagnostic returns only a small prefix and applies the
  // renderer's live matrix, rather than making E2E recreate alignment, RTC,
  // or manual-placement math outside the production path.
  host.__ifc_lite_rendered_point_cloud__ = (handleId: number): RenderedPointCloudSnapshot | null => {
    const sample = getPointCloudScanSample(handleId);
    if (!sample) return null;
    const matrix = renderer.getPointCloudTransform({ id: handleId });
    const points: Array<[number, number, number]> = [];
    for (let index = 0; index < Math.min(sample.count, RENDERED_POINT_CLOUD_DEBUG_LIMIT); index++) {
      const offset = index * 3;
      const raw = { x: sample.positions[offset]!, y: sample.positions[offset + 1]!, z: sample.positions[offset + 2]! };
      const placed = matrix ? MathUtils.transformPoint({ m: matrix }, raw) : raw;
      points.push([placed.x, placed.y, placed.z]);
    }
    return { pointCount: sample.seen, points };
  };
}

export function clearViewportDebugHooks(): void {
  const host = globalThis as Record<string, unknown>;
  delete host.__ifc_lite_render_stats__;
  delete host.__ifc_lite_capture_color_frame__;
  delete host.__ifc_lite_render_visibility__;
  delete host.__ifc_lite_annotation_line_vertices__;
  delete host.__ifc_lite_visibility_reasons__;
  delete host.__ifc_lite_scene_owner__;
  delete host.__ifc_lite_scene_face_hits__;
  delete host.__ifc_lite_rendered_point_cloud__;
}
