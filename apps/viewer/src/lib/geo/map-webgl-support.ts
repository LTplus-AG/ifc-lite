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
 * component instance; the probe-once / latch-for-the-session mechanics that
 * follow from that live in `lib/webgl-capability.ts` and are shared with the
 * three.js surfaces (#2401). This module owns only what is MapLibre-specific:
 * the attributes MapLibre requests, its failure reasons, and the two error
 * shapes it produces. The `Map` constructor's own extension demand (depth +
 * stencil, which WebGL1 on an ANGLE/D3D11 path cannot back without
 * `OES_packed_depth_stencil`) is why the attribute set below has to be exact.
 *
 * Module state is deliberate — remounting (the Georeferencing section is a
 * Radix Collapsible, so collapsing and re-expanding unmounts and remounts the
 * panel) must not re-open the floodgates. Same principle, and the same test
 * seam, as `gpu-upload-guard.ts`.
 *
 * Kept free of `posthog-js` and of `maplibre-gl` on purpose, so the contract is
 * unit-testable under the Node test runner without a browser or a 1 MB map
 * bundle (same discipline as `analytics-scrub.ts`). Reporting is the caller's
 * job; this module only rations it via `takeMapWebglReportSlot`.
 */

import {
  createWebglCapabilityGate,
  type ProbeCanvas,
  type WebglVerdict,
} from '../webgl-capability.js';

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

export type MapWebglVerdict = WebglVerdict<MapWebglFailureReason>;

/**
 * The session-scoped gate. `webgl2` only, because MapLibre v6 dropped WebGL1 —
 * a WebGL1 context is not something it can be constructed with.
 */
const gate = createWebglCapabilityGate<MapWebglFailureReason>({
  attributes: MAP_CONTEXT_ATTRIBUTES,
  probeFailureReason: 'probe_no_context',
  label: 'map',
});

/** Reset the session latches. Test seam — not used in production. */
export function resetMapWebglSupportForTests(): void {
  gate.resetForTests();
}

/** The latched verdict, or `null` if nothing has been determined yet. */
export function getMapWebglVerdict(): MapWebglVerdict | null {
  return gate.getVerdict();
}

/**
 * Latch a negative verdict discovered the hard way — by the real construction
 * throwing, or by the context being lost later. Idempotent: the FIRST reason
 * wins, so the originating failure is the one that gets reported.
 */
export function markMapWebglUnsupported(reason: MapWebglFailureReason): void {
  gate.markUnsupported(reason);
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
  return gate.takeReportSlot();
}

/**
 * Decide whether MapLibre can be constructed, without constructing it. See
 * `WebglCapabilityGate.probe` for why this is an optimisation and never the
 * sole gate — the caller must still wrap the real construction in `try/catch`,
 * because a probe can pass and the context still be refused a moment later
 * (the `BindToCurrentSequence failed` case).
 *
 * @param createCanvas Injected canvas factory. Tests only.
 */
export function probeMapWebglSupport(
  createCanvas?: () => ProbeCanvas | null,
): MapWebglVerdict {
  return gate.probe(createCanvas);
}

// ── Failure-shape recognition ───────────────────────────────────────────────

/**
 * MapLibre v6's own name for the failure.
 *
 * `GPUInitializationError` is an exported class, so `instanceof` would be the
 * stronger test, but reaching for it would mean importing maplibre-gl here and
 * this module stays free of that import on purpose (see the file header). The
 * name is a stable, authored string on the class, not a minified identifier:
 * the bundler cannot rename a string literal assigned to `.name`.
 */
const MAP_GPU_INIT_ERROR_NAME = 'GPUInitializationError';

/** v6's wording. Kept as a second key in case a subclass renames itself. */
const MAP_WEBGL2_REQUIRED_MESSAGE = 'WebGL2 is required to display this map';

/**
 * v5's wording, retained deliberately.
 *
 * v5 threw `new Error(JSON.stringify({requestedAttributes, statusMessage, type,
 * message: 'Failed to initialize WebGL'}))`. v6 does not produce this shape at
 * all, so this line is dead against the pinned version. It stays because the
 * cost is one string comparison and the alternative, if maplibre-gl is ever
 * rolled back, is this module silently failing open on the exact failure it
 * exists to catch.
 */
const MAP_WEBGL_INIT_MESSAGE = 'Failed to initialize WebGL';

/** The DOM event the driver dispatches when it refuses a context. */
const CONTEXT_CREATION_ERROR_EVENT = 'webglcontextcreationerror';

/**
 * Watch a container for the driver's explanation of a refused context.
 *
 * MapLibre v6 does not hand us its `GPUInitializationError`: `_setupPainter`
 * fires it as an `error` event from inside the `Map` constructor, before any
 * `map.on('error')` of ours could be attached, so the object itself is only
 * ever console.errored by `Evented.fire` and then dropped. The diagnostic it
 * carries (`statusMessage`, the difference between "this GPU lacks an
 * extension" and "the GPU process lost a race") would go with it, leaving every
 * map failure in one unactionable bucket in error tracking.
 *
 * The source of that string is a DOM event on the canvas, and the canvas is
 * built into OUR container during the same constructor, so we can be listening
 * before it exists. The capture phase is load-bearing and not a style choice:
 * `webglcontextcreationerror` does not bubble, so an ancestor only ever sees it
 * on the way DOWN to the target.
 *
 * Call `stop()` on every path. The listener is on a container React owns.
 */
export function watchContextCreationStatus(container: {
  addEventListener(type: string, listener: (ev: Event) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (ev: Event) => void, capture: boolean): void;
}): { statusMessage(): string | null; stop(): void } {
  let status: string | null = null;
  const onCreationError = (ev: Event) => {
    const { statusMessage } = ev as Event & { statusMessage?: unknown };
    if (typeof statusMessage === 'string' && statusMessage) status = statusMessage;
  };
  container.addEventListener(CONTEXT_CREATION_ERROR_EVENT, onCreationError, true);
  return {
    statusMessage: () => status,
    stop: () => container.removeEventListener(CONTEXT_CREATION_ERROR_EVENT, onCreationError, true),
  };
}

/**
 * Rebuild the error MapLibre v6 created and then threw away.
 *
 * Reconstruction rather than capture, because the original object is
 * unreachable: it is fired into an `error` event with no listeners and
 * garbage-collected. This carries the same three fields the rest of this module
 * reads (`name`, the v6 wording, `statusMessage`), so a construction that
 * failed without throwing reports exactly like one that threw.
 */
export function reconstructMapInitFailure(statusMessage: string | null): Error {
  const err = new Error(
    `${MAP_WEBGL2_REQUIRED_MESSAGE}. The map could not start: MapLibre built no painter.`,
  ) as Error & { statusMessage: string | null };
  err.name = MAP_GPU_INIT_ERROR_NAME;
  err.statusMessage = statusMessage;
  return err;
}

/**
 * Is this the MapLibre "no WebGL context" failure?
 *
 * Deliberately narrow. It matches MapLibre's own authored wording and its
 * `webglcontextcreationerror` detail token — never a minified class name, which
 * changes every build (the same discipline the Cesium matcher in
 * `analytics-scrub.ts` spells out). Over-matching here would silently swallow
 * an actionable map bug.
 */
export function isWebglContextCreationError(err: unknown): boolean {
  if (err instanceof Error && err.name === MAP_GPU_INIT_ERROR_NAME) return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message) return false;
  return message.includes(MAP_WEBGL2_REQUIRED_MESSAGE)
    || message.includes(MAP_WEBGL_INIT_MESSAGE)
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
 * Pull the diagnostic fields off MapLibre's error.
 *
 * This is the difference between an unactionable "could not start the map"
 * bucket and knowing whether a device is missing an extension or merely lost a
 * race with the GPU process. `requestedAttributes` is deliberately NOT
 * extracted — it is a constant (see `MAP_CONTEXT_ATTRIBUTES`) and would only
 * add payload.
 *
 * Two shapes, because v6 moved the diagnostics from the message to the error:
 *
 *   v6  `GPUInitializationError` carries a real `statusMessage` property (null
 *       when no `webglcontextcreationerror` event supplied one) and a fixed
 *       human message. No event type is exposed, so `eventType` is implied by
 *       a status being present at all.
 *   v5  a single `Error` whose message was the JSON blob parsed below.
 */
export function describeMapInitFailure(err: unknown): MapInitFailureDetail {
  if (err instanceof Error && err.name === MAP_GPU_INIT_ERROR_NAME) {
    const { statusMessage } = err as Error & { statusMessage?: unknown };
    const detail: MapInitFailureDetail = {};
    if (typeof statusMessage === 'string' && statusMessage) {
      detail.status = statusMessage;
      detail.eventType = 'webglcontextcreationerror';
    }
    return detail;
  }

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
