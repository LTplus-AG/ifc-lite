/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Context for the GPU device-loss report (issue #2624).
 *
 * The field occurrence behind #2624 - "GPU device lost (unknown): A valid
 * external Instance reference no longer exists." - was triaged unactionable AS
 * CAPTURED: the message is Chromium/Dawn's, and the event carried only the
 * reason and the raw text, so there was nothing to correlate against. This
 * module is the enrichment that makes the NEXT occurrence diagnosable: what
 * GPU, how much geometry was resident, whether a frame ever rendered, how long
 * the page had been alive, and how big the last loaded model was.
 *
 * Everything here is read AT LOSS TIME, from a renderer whose GPU objects are
 * already dead, so two rules bind every field:
 *
 *  - Each field is read inside its own try/catch and degrades to "omitted".
 *    One half-dead accessor must cost its own field, never the base report
 *    (the reason/detail this event exists to carry).
 *  - Only JS-side state is read: the adapter snapshot is strings copied at
 *    init, `getResidentGpuBytes()` sums retained `.size` fields, and
 *    `getFrameStats()` returns a plain object. No GPU calls.
 *
 * KEY NAMES ARE LOAD-BEARING. `lib/analytics-scrub.ts` DELETES any property
 * whose key contains `name`, `model`, `message`, `description` (and more) as a
 * `_`-delimited word, in `before_send` - so a field named `model_size_mb` or
 * `gpu_description` would ship blind. Every key below is chosen to survive the
 * scrubber, and the scrub-path test in `device-loss-context.test.ts` runs the
 * REAL `scrubEvent` over them so a rename into that word list goes red.
 */

import type { AdapterInfoSnapshot } from '@ifc-lite/renderer';
import { getModelLoadedSnapshot } from '@/utils/loadTelemetry.js';
import { useViewerStore } from '@/store';

/** Flat, scrub-safe enrichment properties for a loss/degradation capture. */
export type DeviceLossContext = Record<string, string | number | boolean | undefined>;

/**
 * The slice of `Renderer` this module reads. Every member is OPTIONAL and
 * structurally minimal (only the fields actually read), so existing test
 * fakes of `ViewportHealthSource` compile unchanged and a fake needs no more
 * than the accessor under test.
 */
export interface DeviceLossContextSource {
  getAdapterInfo?: () => AdapterInfoSnapshot | null;
  getFrameStats?: () => { timestamp: number } | null;
  getScene?: () => { getResidentGpuBytes(): { total: number } };
  getCanvas?: () => { width: number; height: number };
}

/**
 * Read one field, keeping any failure inside the field. `undefined` (returned
 * or thrown-into) means the key is omitted entirely - same null-means-omitted
 * convention as `loadTelemetry.ts`, because PostHog treats an absent property
 * and an explicit null differently in `IS NOT NULL` filters.
 */
function put(
  context: DeviceLossContext,
  key: string,
  read: () => string | number | boolean | undefined,
): void {
  try {
    const value = read();
    if (value !== undefined) context[key] = value;
  } catch {
    // Deliberate swallow: this runs on the device-loss path, where a hostile
    // or half-torn-down accessor must cost its own field, never the base
    // report - and per-field console noise would bury the loss breadcrumb.
  }
}

/**
 * Build the enrichment properties for a device-loss (or persistent
 * render-degradation) capture. Never throws; a field whose source is missing
 * or broken is omitted.
 *
 * Call this AT LOSS TIME, not at subscribe time: the point of
 * `ms_since_last_frame` and `gpu_resident_mb` is to describe the moment the
 * device died, not the moment the Viewport mounted.
 */
export function buildDeviceLossContext(source: DeviceLossContextSource): DeviceLossContext {
  const context: DeviceLossContext = {};

  // Adapter identity, snapshotted at init (plain strings; see AdapterInfoSnapshot).
  put(context, 'gpu_vendor', () => source.getAdapterInfo?.()?.vendor);
  put(context, 'gpu_architecture', () => source.getAdapterInfo?.()?.architecture);

  // GPU-resident geometry at the moment of loss. Allocation-accurate JS-side
  // sum (`Scene.getResidentGpuBytes()` reads retained `.size` fields), so it
  // is safe to read after the device died. Rounded to MB - the question is
  // "was VRAM plausibly exhausted?", not byte accounting.
  put(context, 'gpu_resident_mb', () => {
    const scene = source.getScene?.();
    return scene ? Math.round(scene.getResidentGpuBytes().total / (1024 * 1024)) : undefined;
  });

  // Did the device die before ever completing a frame? A loss during init or
  // first upload is a different bug family from one mid-session.
  put(context, 'had_rendered_frame', () =>
    source.getFrameStats ? source.getFrameStats() !== null : undefined,
  );
  put(context, 'ms_since_last_frame', () => {
    const stats = source.getFrameStats?.();
    return stats ? Math.round(performance.now() - stats.timestamp) : undefined;
  });

  // No app-level session-start concept exists; the page's own clock is the
  // right "how long into the session" measure.
  put(context, 'ms_since_page_load', () => Math.round(performance.now()));

  // A loss in a backgrounded tab points at the browser reclaiming the GPU
  // rather than at anything the model did. Guarded: this module's tests run
  // under node:test where `document` genuinely does not exist.
  put(context, 'tab_visibility', () =>
    typeof document !== 'undefined' ? document.visibilityState : undefined,
  );

  // Surface size: an oversized canvas (zoomed display, huge DPR) is a known
  // way to exhaust a weak GPU.
  put(context, 'canvas_width', () => source.getCanvas?.().width);
  put(context, 'canvas_height', () => source.getCanvas?.().height);
  put(context, 'device_pixel_ratio', () =>
    typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
      ? window.devicePixelRatio
      : undefined,
  );

  // Load-time fidelity config (Fast/Exact and the sticky `?geomTier=` pin,
  // #2544): both change how much geometry a given file puts on the GPU.
  put(context, 'geometry_mode', () => useViewerStore.getState().geometryMode);
  put(context, 'geom_tier_override', () => useViewerStore.getState().geomTierOverride);

  // Size of the last completed load (recorded at the `ifc_model_loaded`
  // capture site). Omitted when no load completed - itself a signal.
  put(context, 'last_load_file_size_mb', () => {
    const snapshot = getModelLoadedSnapshot();
    return snapshot ? Math.round(snapshot.fileSizeMB * 100) / 100 : undefined;
  });
  put(context, 'last_load_total_triangles', () => getModelLoadedSnapshot()?.totalTriangles);
  put(context, 'last_load_mesh_count', () => getModelLoadedSnapshot()?.meshCount);

  return context;
}
