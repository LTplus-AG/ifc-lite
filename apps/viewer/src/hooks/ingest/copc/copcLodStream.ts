/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * View-dependent COPC streaming for the viewer (#6869).
 *
 * `streamPointCloudOrCopc` is what `ingestPointCloud` calls instead of
 * `streamPointCloud`: a LAS/LAZ blob whose first VLR is `copc`/`info` (the
 * name does not matter) takes the LOD path; everything else streams exactly
 * as before. So COPC goes through the one canonical load path
 * (`useIfcLoader.loadFile` → `ingestPointCloud`) and keeps its alignment,
 * CRS, picking, placement and lifecycle wiring.
 *
 * The LOD path keeps ONE renderer asset and adds/removes one keyed chunk
 * per octree node. `done` resolves once the coarse overview (levels 0-2)
 * is resident, which seeds bounds and the scan cache; after that a rAF
 * watcher re-runs the selection whenever the camera has been still for
 * `CAMERA_SETTLE_MS`.
 */

import type { Renderer } from '@ifc-lite/renderer';
import {
  COPC_PROBE_BYTES,
  createCopcLodTree,
  isCopcHeader,
  openCopcWorkerReader,
  parseLasHeader,
  streamPointCloud,
  type CopcWorkerReader,
  type StreamHandle,
  type StreamPointCloudOptions,
} from '@ifc-lite/pointcloud';
import type { CopcLodController } from './copcLodController.js';
import { lodCameraInDecodedFrame, overviewCamera } from './copcLodCamera.js';
import { createCopcLodSink } from './copcLodSink.js';
import { createStreamController, loadOverview } from './copcLodWiring.js';

/** Resident point ceiling: 2.5x below the old whole-file cap, at any file size. */
export const DEFAULT_COPC_POINT_BUDGET = 10_000_000;
const CAMERA_SETTLE_MS = 150;

export interface CopcIngestContext {
  renderer: Renderer;
  handle: { id: number };
  pointBudget?: number;
  /** Running class histogram estimate (counts scaled by each node's stride). */
  onClassCounts?: (counts: Record<number, number> | null) => void;
}

const running = new Map<number, () => void>();
const diagnostics = new Map<number, () => unknown>();

/**
 * Read-only e2e/console diagnostic, the `__ifc_lite_*` convention: resident
 * nodes per COPC asset, the camera the last selection used, hierarchy state.
 */
(globalThis as Record<string, unknown>).__ifc_lite_copc_lod__ = () =>
  Object.fromEntries([...diagnostics].map(([id, read]) => [id, read()]));

/** Stop the LOD stream feeding `handleId` (model removed). Safe to call for any id. */
export function stopCopcLodStream(handleId: number): void {
  running.get(handleId)?.();
}

/** COPC blobs take the LOD path; every other blob streams as before. */
export function streamPointCloudOrCopc(options: StreamPointCloudOptions, copc: CopcIngestContext): StreamHandle {
  if ((options.format !== 'las' && options.format !== 'laz') || options.createSource) return streamPointCloud(options);
  const local = new AbortController();
  let inner: StreamHandle | null = null;
  const done = (async () => {
    try {
      const head = new Uint8Array(await options.blob.slice(0, COPC_PROBE_BYTES).arrayBuffer());
      if (local.signal.aborted || options.signal?.aborted) return;
      inner = isCopcHeader(head) ? startCopcLod(options, copc, head) : streamPointCloud(options);
    } catch (err) {
      // The probe or a synchronous stream-setup throw: report it through the
      // same onError the ingest relies on for cleanup, as a stream error would.
      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);
      throw error;
    }
    await inner.done;
  })();
  return {
    cancel: () => {
      local.abort();
      inner?.cancel();
    },
    done,
  };
}

function startCopcLod(options: StreamPointCloudOptions, ctx: CopcIngestContext, head: Uint8Array): StreamHandle {
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const budget = ctx.pointBudget ?? DEFAULT_COPC_POINT_BUDGET;
  const header = parseLasHeader(head);
  const box = header.bbox;
  // Same local origin `autoOrigin` picks for LAS/LAZ: the header box centre.
  const originOffset = options.originOffset ?? [
    (box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2,
  ] as const;
  let reader: CopcWorkerReader | null = null;
  let controller: CopcLodController | null = null;
  let frame = 0;
  let loaded = false;
  let trackCamera: (camera: unknown) => void = () => {};
  let failAfterLoad: (err: unknown) => void = () => {};
  const stop = () => {
    abort.abort();
    cancelAnimationFrame(frame);
    controller?.dispose();
    reader?.close();
    running.delete(ctx.handle.id);
    diagnostics.delete(ctx.handle.id);
  };
  running.set(ctx.handle.id, stop);

  const done = (async () => {
    reader = await openCopcWorkerReader({ source: { kind: 'blob', blob: options.blob }, originOffset, signal });
    const info = reader.file.info;
    const bbox = {
      min: [box.min[0] - originOffset[0], box.min[1] - originOffset[1], box.min[2] - originOffset[2]] as [number, number, number],
      max: [box.max[0] - originOffset[0], box.max[1] - originOffset[1], box.max[2] - originOffset[2]] as [number, number, number],
    };
    options.onOpen?.({
      totalPointCount: header.pointCount,
      bbox,
      hasColor: header.hasRgb, hasClassification: true, hasIntensity: true,
      label: options.label, spatialMetadata: reader.file.spatialMetadata, stride: 1, originOffset,
    });
    const sink = createCopcLodSink(ctx);
    // After load, only a REAL failure (unreadable hierarchy page, a renderer
    // that refuses a chunk) ends the stream. It is reported through the
    // ingest's onError, which owns cleanup. Superseded work never gets here:
    // the controller resolves aborted updates.
    failAfterLoad = (err: unknown) => {
      if (signal.aborted) return;
      console.error('[copc-lod] stopping the LOD stream:', err);
      stop();
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    };
    const activeReader = reader;
    controller = createStreamController(createCopcLodTree(reader.hierarchy, info, originOffset), activeReader, sink, {
      pointBudget: budget,
      onError: failAfterLoad,
      onProgress: (points) => options.onProgress?.(points, header.pointCount),
      isLoaded: () => loaded,
    });
    let lastCamera: unknown = null;
    diagnostics.set(ctx.handle.id, () => ({
      residentPoints: controller?.points, residentNodes: controller?.nodeCount, selection: controller?.lastSelection,
      strides: (controller?.residentNodes() ?? []).reduce<Record<number, number>>((acc, n) => ({ ...acc, [n.stride]: (acc[n.stride] ?? 0) + 1 }), {}),
      deepest: Math.max(0, ...(controller?.residentNodes() ?? []).map((n) => Number(n.id.split('-')[0]))),
      loadedPages: activeReader.hierarchy.loadedPageCount, pendingPages: activeReader.hierarchy.pendingPages.size,
      cube: info, originOffset, lastCamera,
    }));
    trackCamera = (camera) => { lastCamera = camera; };
    await loadOverview({
      controller, sink, camera: overviewCamera(info, originOffset), signal,
      markLoaded: () => { loaded = true; },
      onComplete: (points) => options.onComplete?.(bbox, points, null),
    });
    watchCamera();
  })().catch((err: unknown) => {
    const aborted = signal.aborted;
    stop();
    if (aborted) return;
    const error = err instanceof Error ? err : new Error(String(err));
    options.onError?.(error);
    throw error;
  });

  /** Re-select after the camera (or the asset's placement) has been still for a moment. */
  function watchCamera(): void {
    let last = '';
    let changedAt = 0;
    let dirty = true;
    const tick = (now: number) => {
      if (signal.aborted || !controller) return;
      // A torn-down viewport or a lost device owns none of our chunks any more.
      if (!ctx.renderer.isReady()) {
        stop();
        return;
      }
      const camera = ctx.renderer.getCamera();
      const model = ctx.renderer.getPointCloudTransform(ctx.handle);
      const height = ctx.renderer.getCanvas().clientHeight || ctx.renderer.getCanvas().height;
      const viewProj = camera.getViewProjMatrix().m;
      const key = `${Array.from(viewProj).join(',')}|${model ? Array.from(model).join(',') : ''}|${height}`;
      if (key !== last) {
        last = key;
        changedAt = now;
        dirty = true;
      } else if (dirty && now - changedAt >= CAMERA_SETTLE_MS) {
        dirty = false;
        const eye = camera.getPosition();
        const lodCamera = lodCameraInDecodedFrame({
          viewProj, proj: camera.getProjMatrix().m, eye: [eye.x, eye.y, eye.z], viewportHeight: height,
          orthographic: camera.getProjectionMode() === 'orthographic', model,
        });
        if (lodCamera) {
          trackCamera(lodCamera);
          controller.update(lodCamera).catch(failAfterLoad);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  return { cancel: stop, done };
}
