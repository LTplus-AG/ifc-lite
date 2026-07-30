/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGL capability gate for the LocationMap minimap.
 *
 * MapLibre's `Map` constructor is not fail-soft: `_setupContainer()` mutates the
 * container we hand it (adds `maplibregl-map`, creates the canvas + control
 * containers, attaches `webglcontextlost`/`restored` listeners) and only THEN
 * does `_setupPainter()` ask for a WebGL context. When the browser refuses one,
 * `_setupPainter` throws synchronously:
 *
 *   throw new Error(JSON.stringify({ requestedAttributes, statusMessage, type,
 *                                    message: 'Failed to initialize WebGL' }))
 *
 * — or, when no `webglcontextcreationerror` event carried a detail object, the
 * bare `new Error('Failed to initialize WebGL')`. Both shapes reached error
 * tracking as UNCAUGHT exceptions, because the construction site sits inside a
 * `.then()` callback whose derived promise nobody handled.
 *
 * The refusal is a property of the DEVICE, not of the model or of any one
 * component instance. Two real examples, same session, same machine (an AMD
 * integrated GPU on ANGLE/D3D11):
 *
 *   "OES_packed_depth_stencil support is required."
 *   "Could not create a WebGL context, ... ErrorMessage = BindToCurrentSequence failed: ."
 *
 * The first is a hard capability gap (MapLibre demands depth + stencil; WebGL1
 * on that ANGLE path cannot back them without the extension). The second is the
 * GPU process being unable to serve a context at that moment — the viewport
 * renderer is WebGPU, so MapLibre is a second, independent GPU consumer in the
 * same process. Neither is actionable by the user beyond reloading.
 *
 * Hence: probe once, latch the verdict for the session, and let the caller show
 * a fallback instead of a blank box. Module state is deliberate — remounting
 * (the Georeferencing section is a Radix Collapsible, so collapsing and
 * re-expanding unmounts and remounts the panel) must not re-open the floodgates.
 * Same principle, and the same test seam, as `gpu-upload-guard.ts`.
 *
 * Kept free of `posthog-js` and of `maplibre-gl` on purpose, so the contract is
 * unit-testable under the Node test runner without a browser or a 1 MB map
 * bundle (same discipline as `analytics-scrub.ts`). Reporting is the caller's
 * job; this module only rations it via `takeMapWebglReportSlot`.
 */

/**
 * The context attributes MapLibre actually requests.
 *
 * `_setupPainter` merges the constructor's `canvasContextAttributes` defaults
 * with the four values it force-overrides (`alpha`, `depth`, `stencil`,
 * `premultipliedAlpha`). Probing with anything less faithful would be worse
 * than not probing at all: `depth` + `stencil` are precisely what the reported
 * `OES_packed_depth_stencil` failure trips over, so a lazier probe would return
 * "supported" on the very device this exists for.
 *
 * Keep in step with maplibre-gl's `defaultOptions.canvasContextAttributes` on
 * upgrade — a drift here only costs probe fidelity, never correctness, because
 * the caller still wraps the real construction in `try/catch`.
 */
const MAP_CONTEXT_ATTRIBUTES: Readonly<Record<string, unknown>> = Object.freeze({
  antialias: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
  desynchronized: false,
  alpha: true,
  depth: true,
  stencil: true,
  premultipliedAlpha: true,
});

/** Why the map is unavailable. Low-cardinality: safe as an analytics property. */
export type MapWebglFailureReason =
  /** The pre-flight probe could not get a context at all. */
  | 'probe_no_context'
  /** The probe passed but `new maplibregl.Map(...)` still threw. */
  | 'map_construction_failed'
  /** The context was lost after the map had been running. */
  | 'context_lost';

export interface MapWebglVerdict {
  supported: boolean;
  /** Present only when `supported` is false. */
  reason?: MapWebglFailureReason;
}

/** Minimal structural types so the probe can be driven by a fake in tests. */
interface ProbeContext {
  getExtension(name: string): { loseContext?: () => void } | null;
}
interface ProbeCanvas {
  getContext(type: string, attributes?: unknown): ProbeContext | null;
}

const SUPPORTED: MapWebglVerdict = Object.freeze({ supported: true });

// ── Session-scoped state ────────────────────────────────────────────────────
// `null` means "not yet determined". Once set, the verdict stands for the rest
// of the session: a device that cannot serve a WebGL context will not start
// doing so because the user re-opened an accordion, and re-probing would burn
// a context slot each time.
let verdict: MapWebglVerdict | null = null;
let reportSlotTaken = false;

/** Reset the session latches. Test seam — not used in production. */
export function resetMapWebglSupportForTests(): void {
  verdict = null;
  reportSlotTaken = false;
}

/** The latched verdict, or `null` if nothing has been determined yet. */
export function getMapWebglVerdict(): MapWebglVerdict | null {
  return verdict;
}

/**
 * Latch a negative verdict discovered the hard way — by the real construction
 * throwing, or by the context being lost later. Idempotent: the FIRST reason
 * wins, so the originating failure is the one that gets reported.
 */
export function markMapWebglUnsupported(reason: MapWebglFailureReason): void {
  if (verdict && !verdict.supported) return;
  verdict = { supported: false, reason };
}

/**
 * Claim the once-per-session slot for reporting this failure to error tracking.
 *
 * Returns `true` exactly once. These failures repeat on every remount, and the
 * production evidence is two events from a single user in a single session —
 * enough to show the pattern, and enough to flood the exception quota on a
 * device where the user keeps toggling the panel.
 */
export function takeMapWebglReportSlot(): boolean {
  if (reportSlotTaken) return false;
  reportSlotTaken = true;
  return true;
}

const defaultCanvasFactory = (): ProbeCanvas | null =>
  typeof document === 'undefined' ? null : document.createElement('canvas');

/**
 * Decide whether MapLibre can be constructed, without constructing it.
 *
 * Cheap: a detached 1x1 canvas, `webgl2` then `webgl` (MapLibre's own order),
 * and the context is released immediately via `WEBGL_lose_context`. Releasing
 * is load-bearing, not tidiness — a browser allows only ~16 live WebGL contexts
 * per page, so a probe that leaked one could *cause* the failure it screens for.
 *
 * The probe is an optimisation, never the sole gate: it lets the fallback be
 * the user's first paint instead of a caught throw, and it keeps MapLibre from
 * leaving a half-built canvas in our container. The caller must still wrap the
 * real construction in `try/catch`, because a probe can pass and the context
 * still be refused a moment later under GPU-process contention — which is
 * exactly the `BindToCurrentSequence failed` case.
 *
 * When there is no `document` (the Node test runner, SSR) the verdict is
 * optimistic: nothing renders there anyway, and guessing "unsupported" would
 * be a worse default than deferring to the `try/catch`.
 *
 * @param createCanvas Injected canvas factory. Tests only.
 */
export function probeMapWebglSupport(
  createCanvas: () => ProbeCanvas | null = defaultCanvasFactory,
): MapWebglVerdict {
  if (verdict) return verdict;

  let gl: ProbeContext | null = null;
  let canvas: ProbeCanvas | null = null;
  try {
    canvas = createCanvas();
    // No DOM to probe with: stay optimistic and let the `try/catch` decide.
    if (!canvas) return (verdict = SUPPORTED);
    gl = canvas.getContext('webgl2', MAP_CONTEXT_ATTRIBUTES)
      ?? canvas.getContext('webgl', MAP_CONTEXT_ATTRIBUTES);
  } catch {
    // `getContext` is not specified to throw, but a wedged GPU process has been
    // seen to. Treat a throw exactly like a refusal.
    gl = null;
  } finally {
    // Hand the context straight back, on every path including the failure one.
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext?.();
    } catch { /* releasing is best-effort; never mask the verdict */ }
  }

  verdict = gl ? SUPPORTED : { supported: false, reason: 'probe_no_context' };
  return verdict;
}

// ── Failure-shape recognition ───────────────────────────────────────────────

/** MapLibre's message when it cannot get a context, both shapes share it. */
const MAP_WEBGL_INIT_MESSAGE = 'Failed to initialize WebGL';

/**
 * Is this the MapLibre "no WebGL context" failure?
 *
 * Deliberately narrow. It matches MapLibre's own wording and its
 * `webglcontextcreationerror` detail token — never a minified class name, which
 * changes every build (the same discipline the Cesium matcher in
 * `analytics-scrub.ts` spells out). Over-matching here would silently swallow
 * an actionable map bug.
 */
export function isWebglContextCreationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message) return false;
  return message.includes(MAP_WEBGL_INIT_MESSAGE)
    || message.includes('"type":"webglcontextcreationerror"');
}

export interface MapInitFailureDetail {
  /**
   * The driver's explanation, e.g. `OES_packed_depth_stencil support is
   * required.` Carries no model, file or user data — it describes the GPU.
   */
  status?: string;
  /** The DOM event type MapLibre captured, normally `webglcontextcreationerror`. */
  eventType?: string;
}

/**
 * Pull the diagnostic fields out of MapLibre's JSON-stringified error.
 *
 * This is the difference between an unactionable "Failed to initialize WebGL"
 * bucket and knowing whether a device is missing an extension or merely lost a
 * race with the GPU process. `requestedAttributes` is deliberately NOT
 * extracted — it is a constant (see `MAP_CONTEXT_ATTRIBUTES`) and would only
 * add payload.
 */
export function describeMapInitFailure(err: unknown): MapInitFailureDetail {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message.startsWith('{')) return {};
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== 'object') return {};
    const { statusMessage, type } = parsed as Record<string, unknown>;
    const detail: MapInitFailureDetail = {};
    if (typeof statusMessage === 'string' && statusMessage) detail.status = statusMessage;
    if (typeof type === 'string' && type) detail.eventType = type;
    return detail;
  } catch {
    // Not JSON after all — the bare-message shape. No detail to add.
    return {};
  }
}
