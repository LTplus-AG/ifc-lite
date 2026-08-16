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
 *    (the reason/detail this event exists to carry). A read that THROWS is
 *    still surfaced - named in the `failed_fields` marker and warned once
 *    within a session-capped budget - so a broken accessor of ours stays
 *    distinguishable from a browser that simply lacks the metric.
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
 * Console-warn budget for throwing field accessors. A read that THROWS is a
 * defect in our own enrichment (an unavailable metric returns `undefined`
 * instead), so it must be surfaced - but this runs on the loss/teardown path,
 * where a repeatedly-throwing accessor could otherwise flood the console and
 * bury the loss breadcrumb. Failures past the cap still reach telemetry via
 * the `failed_fields` marker on every report.
 */
const MAX_FIELD_FAILURE_WARNS = 8;
let fieldFailureWarns = 0;

/** Reset the warn budget. Test seam - not used in production. */
export function resetDeviceLossContextWarnsForTests(): void {
  fieldFailureWarns = 0;
}

function warnFieldFailure(key: string, err: unknown): void {
  if (fieldFailureWarns >= MAX_FIELD_FAILURE_WARNS) return;
  fieldFailureWarns++;
  // `[Viewport]`, like the rest of the loss-path modules (see
  // device-loss-report.ts on why the prefix names the subsystem).
  console.warn(`[Viewport] device-loss context accessor threw; field omitted: ${key}`, err);
}

/**
 * Build the enrichment properties for a device-loss (or persistent
 * render-degradation) capture. Never throws; a field whose source is missing
 * or broken is omitted, and every field that failed by THROWING (as opposed to
 * legitimately reporting `undefined`) is named in a `failed_fields` marker -
 * so the telemetry itself distinguishes "this browser lacks the metric" from
 * "our accessor is broken", the exact ambiguity this feature exists to remove.
 *
 * Call this AT LOSS TIME, not at subscribe time: the point of
 * `ms_since_last_frame` and `gpu_resident_mb` is to describe the moment the
 * device died, not the moment the Viewport mounted.
 */
export function buildDeviceLossContext(source: DeviceLossContextSource): DeviceLossContext {
  const context: DeviceLossContext = {};
  const failedFields: string[] = [];

  /**
   * Read one field, keeping any failure inside the field. `undefined`
   * (returned or thrown-into) means the key is omitted entirely - same
   * null-means-omitted convention as `loadTelemetry.ts`, because PostHog
   * treats an absent property and an explicit null differently in
   * `IS NOT NULL` filters. A THROW additionally lands the key in
   * `failed_fields` and a capped console.warn: it must cost only its own
   * field, never the base report, but never silently either.
   */
  const put = (
    key: string,
    read: () => string | number | boolean | undefined,
  ): void => {
    try {
      const value = read();
      if (value !== undefined) context[key] = value;
    } catch (err) {
      failedFields.push(key);
      warnFieldFailure(key, err);
    }
  };

  // Adapter identity, snapshotted at init (plain strings; see AdapterInfoSnapshot).
  put('gpu_vendor', () => source.getAdapterInfo?.()?.vendor);
  put('gpu_architecture', () => source.getAdapterInfo?.()?.architecture);

  // GPU-resident geometry at the moment of loss. Allocation-accurate JS-side
  // sum (`Scene.getResidentGpuBytes()` reads retained `.size` fields), so it
  // is safe to read after the device died. Rounded to MB - the question is
  // "was VRAM plausibly exhausted?", not byte accounting.
  put('gpu_resident_mb', () => {
    const scene = source.getScene?.();
    return scene ? Math.round(scene.getResidentGpuBytes().total / (1024 * 1024)) : undefined;
  });

  // Did the device die before ever completing a frame? A loss during init or
  // first upload is a different bug family from one mid-session.
  put('had_rendered_frame', () =>
    source.getFrameStats ? source.getFrameStats() !== null : undefined,
  );
  put('ms_since_last_frame', () => {
    const stats = source.getFrameStats?.();
    return stats ? Math.round(performance.now() - stats.timestamp) : undefined;
  });

  // No app-level session-start concept exists; the page's own clock is the
  // right "how long into the session" measure.
  put('ms_since_page_load', () => Math.round(performance.now()));

  // A loss in a backgrounded tab points at the browser reclaiming the GPU
  // rather than at anything the model did. Guarded: this module's tests run
  // under node:test where `document` genuinely does not exist.
  put('tab_visibility', () =>
    typeof document !== 'undefined' ? document.visibilityState : undefined,
  );

  // Surface size: an oversized canvas (zoomed display, huge DPR) is a known
  // way to exhaust a weak GPU.
  put('canvas_width', () => source.getCanvas?.().width);
  put('canvas_height', () => source.getCanvas?.().height);
  put('device_pixel_ratio', () =>
    typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
      ? window.devicePixelRatio
      : undefined,
  );

  // Load-time fidelity config (Fast/Exact and the sticky `?geomTier=` pin,
  // #2544): both change how much geometry a given file puts on the GPU.
  put('geometry_mode', () => useViewerStore.getState().geometryMode);
  put('geom_tier_override', () => useViewerStore.getState().geomTierOverride);

  // Size of the last completed load (recorded at the `ifc_model_loaded`
  // capture site). Omitted when no load completed - itself a signal.
  //
  // TRIAGE CAVEAT: the triangle/mesh figures count the flat mesh path only.
  // Fully GPU-instanced entities never enter `GeometryResult.meshes` - the
  // partial-model property behind #2558 - so on the wasm STEP and cache load
  // paths these UNDERCOUNT heavily instanced models, sometimes substantially.
  // Do not read `last_load_total_triangles` as "how big the model was"; it is
  // "what the flat path uploaded", kept because it matches `ifc_model_loaded`
  // for the same load by design. `gpu_resident_mb` above is the figure to
  // trust for what was actually on the device: it sums instanced templates
  // too.
  put('last_load_file_size_mb', () => {
    const snapshot = getModelLoadedSnapshot();
    return snapshot ? Math.round(snapshot.fileSizeMB * 100) / 100 : undefined;
  });
  put('last_load_total_triangles', () => getModelLoadedSnapshot()?.totalTriangles);
  put('last_load_mesh_count', () => getModelLoadedSnapshot()?.meshCount);

  // Which enrichment accessors THREW (comma-joined keys from the fixed
  // vocabulary above - never user data). Absent when everything read cleanly.
  // Key checked against the analytics-scrub SENSITIVE_KEY word list like every
  // other key here ("failed"/"fields" are not on it), pinned by the real-
  // scrubEvent test in device-loss-context.test.ts.
  if (failedFields.length > 0) context.failed_fields = failedFields.join(',');

  return context;
}
