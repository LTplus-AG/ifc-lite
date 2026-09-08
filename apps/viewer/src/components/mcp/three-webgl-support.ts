/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGL capability gate for the two `/mcp` three.js surfaces (issue #2401).
 *
 * `THREE.WebGLRenderer` is not fail-soft. Its constructor asks for the context
 * itself and throws when the browser refuses (three@0.185.1, verbatim):
 *
 *   _gl = getContext( 'webgl2', contextAttributes );
 *   if ( _gl === null ) {
 *     if ( getContext( 'webgl2' ) ) throw new Error( 'THREE.WebGLRenderer: Error creating WebGL context with your selected attributes.' );
 *     else                          throw new Error( 'THREE.WebGLRenderer: Error creating WebGL context.' );
 *   }
 *
 * Both `HeroScene` and `PlaygroundViewer` construct it synchronously from a
 * mount effect, so that throw unwinds the whole `/mcp` route into
 * `App.tsx`'s `ChunkErrorBoundary` and replaces an entire page of GPU-free
 * content with a "stopped working / Reload" card — on a device where reloading
 * cannot help, because the refusal is a property of the device. The field
 * report behind this (a desktop Chrome on Linux, on `/mcp`) carried the second
 * message: no `webgl2` at all.
 *
 * The probe-once / latch-for-the-session mechanics are shared with the
 * MapLibre minimap in `lib/webgl-capability.ts`; this module owns what is
 * three-specific — the attributes three requests, its two failure reasons, and
 * its two authored error strings.
 *
 * Kept free of `posthog-js` and of React so the contract is unit-testable
 * under the Node test runner. Reporting and rendering are the caller's job
 * (see `useThreeScene.ts`); this module only rations the report via
 * `takeThreeWebglReportSlot`.
 */

import {
  createWebglCapabilityGate,
  type WebglVerdict,
} from '@/lib/webgl-capability';

/**
 * The context attributes three.js actually requests for our two call sites.
 *
 * Read off `WebGLRenderer`'s constructor in three@0.185.1: it destructures its
 * parameters with defaults (`depth = true`, `stencil = false`,
 * `antialias = false`, `premultipliedAlpha = true`,
 * `preserveDrawingBuffer = false`, `powerPreference = 'default'`,
 * `failIfMajorPerformanceCaveat = false`) and then builds `contextAttributes`
 * with `alpha` hardcoded to `true` regardless of the `alpha` parameter — the
 * renderer's own `alpha` only drives its clear colour.
 *
 * Both `hero-scene.ts` and `playground-scene.ts`'s `createScene` pass
 * `{ antialias: true, alpha: true, powerPreference: 'high-performance' }`, so
 * the values below are the merge of those two facts. `antialias` and
 * `powerPreference` are exactly the kind of request a constrained device
 * refuses, which is why the probe has to carry them: a lazier probe would
 * return "supported" on the device this exists for.
 *
 * Keep in step with `WebGLRenderer`'s defaults and with the two call sites on
 * upgrade — a drift here only costs probe fidelity, never correctness, because
 * the construction is still wrapped in `try/catch`.
 */
const THREE_CONTEXT_ATTRIBUTES: Readonly<Record<string, unknown>> = Object.freeze({
  alpha: true,
  depth: true,
  stencil: false,
  antialias: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
});

/** Why the 3D scene is unavailable. Low-cardinality: safe as an analytics property. */
export type ThreeWebglFailureReason =
  /** The pre-flight probe could not get a context at all. */
  | 'probe_no_context'
  /** The probe passed but `new THREE.WebGLRenderer(...)` still threw. */
  | 'renderer_construction_failed';

export type ThreeWebglVerdict = WebglVerdict<ThreeWebglFailureReason>;

/** Which `/mcp` surface degraded. Fixed strings, never user data. */
export type ThreeSurface = 'hero' | 'playground';

const gate = createWebglCapabilityGate<ThreeWebglFailureReason>({
  attributes: THREE_CONTEXT_ATTRIBUTES,
  probeFailureReason: 'probe_no_context',
  label: 'three',
});

/** The latched verdict, or `null` if nothing has been determined yet. */
export function getThreeWebglVerdict(): ThreeWebglVerdict | null {
  return gate.getVerdict();
}

/** Claim the once-per-session slot for reporting this to error tracking. */
export function takeThreeWebglReportSlot(): boolean {
  return gate.takeReportSlot();
}

/** Reset the session latches. Test seam — not used in production. */
export function resetThreeWebglSupportForTests(): void {
  gate.resetForTests();
}

/**
 * Is this three.js's "the browser refused a WebGL context" throw?
 *
 * Deliberately narrow, and matched on three's own authored prefix rather than
 * on a minified class name (which changes every build — the same discipline
 * the Cesium and MapLibre matchers spell out). Over-matching here would
 * silently swallow an actionable bug in our own scene code as "your device
 * cannot do 3D", which is both a lie to the user and a lost bug report.
 */
const THREE_CONTEXT_ERROR_PREFIX = 'THREE.WebGLRenderer: Error creating WebGL context';

/** three's wording when `webgl2` works bare but not with our attributes. */
const THREE_ATTRIBUTES_REFUSED = 'with your selected attributes';

export function isThreeWebglContextError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message.startsWith(THREE_CONTEXT_ERROR_PREFIX);
}

/**
 * The message the probe path reports with.
 *
 * Synthesised rather than captured, because on this path three never ran: the
 * probe answered first, which is the entire point of pre-flighting. It carries
 * three's own prefix so the event groups with the throws it pre-empts, and a
 * suffix so a reader can tell the two apart. Same shape as the MapLibre
 * pre-flight message in `LocationMap.tsx`.
 */
export function threeProbeFailureError(): Error {
  return new Error(`${THREE_CONTEXT_ERROR_PREFIX}. (pre-flight probe)`);
}

/**
 * Pull a low-cardinality diagnostic off the failure.
 *
 * `attributes_refused` is the actionable half: it means the device CAN serve
 * `webgl2` and refused only the attribute set (antialias / high-performance),
 * which we could plausibly retry with a cheaper set. `no_context` means the
 * device has no `webgl2` at all and nothing we ask for will change that.
 * Returns no key at all for a non-three error so the property stays honest.
 */
export function describeThreeWebglFailure(err: unknown): { webgl_context?: string } {
  if (!isThreeWebglContextError(err)) return {};
  const message = err instanceof Error ? err.message : String(err);
  return { webgl_context: message.includes(THREE_ATTRIBUTES_REFUSED) ? 'attributes_refused' : 'no_context' };
}

/**
 * The outcome of trying to bring a three.js scene up.
 *
 * A discriminated union rather than a nullable handle, so a caller cannot
 * reach for `handle` on the failure path without the compiler noticing.
 */
export type ThreeSceneStart<Handle> =
  | { ok: true; handle: Handle }
  | {
    ok: false;
    reason: ThreeWebglFailureReason;
    /**
     * The error worth reporting, present only when THIS call discovered the
     * failure. Absent when the session latch already knew, so a remount does
     * not manufacture a second report of the same device fact.
     */
    error?: unknown;
  };

/**
 * Bring a three.js scene up behind the capability gate.
 *
 * Three ordered chances to avoid the crash, in increasing cost:
 *
 *   1. the session latch — a device already known to refuse a context is never
 *      asked again, so remounting is free and cannot flash a dead canvas;
 *   2. the pre-flight probe — makes the fallback the user's FIRST paint rather
 *      than something that swaps in after a caught throw;
 *   3. `try/catch` around the real construction — the probe is an optimisation,
 *      not a guarantee: it can pass and the context still be refused a moment
 *      later under GPU-process contention.
 *
 * A throw that is NOT three's context refusal is rethrown untouched. That is
 * deliberate: a bug in our own scene-building code must stay loud and reach
 * error tracking as the real thing, not be relabelled "your device cannot do
 * 3D". Only the failure this gate understands is converted into a degradation.
 */
export function startThreeScene<Handle>(
  container: HTMLElement,
  create: (container: HTMLElement) => Handle,
): ThreeSceneStart<Handle> {
  const latched = gate.getVerdict();
  if (latched && !latched.supported) {
    return { ok: false, reason: latched.reason ?? 'probe_no_context' };
  }

  // No `markUnsupported` here: a failing probe has already latched the verdict
  // itself, with this same reason. Marking again would be a second, silently
  // redundant source of truth for the latch.
  if (!gate.probe().supported) {
    return { ok: false, reason: 'probe_no_context', error: threeProbeFailureError() };
  }

  try {
    return { ok: true, handle: create(container) };
  } catch (err) {
    if (!isThreeWebglContextError(err)) throw err;
    gate.markUnsupported('renderer_construction_failed');
    return { ok: false, reason: 'renderer_construction_failed', error: err };
  }
}
