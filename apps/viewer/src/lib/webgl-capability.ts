/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Session-latched WebGL capability gate.
 *
 * Two independent GPU consumers in this app are constructed by libraries that
 * are not fail-soft — MapLibre's `Map` (the LocationMap minimap) and three.js's
 * `WebGLRenderer` (the `/mcp` hero and playground). Both ask the browser for a
 * WebGL context inside a constructor and blow up when it is refused, and both
 * are constructed from a React effect, where a throw takes the surrounding
 * subtree down instead of degrading it (issues #1914 and #2401).
 *
 * The refusal is a property of the DEVICE, not of the model, the route, or any
 * one component instance. Two real examples from error tracking, same session,
 * same machine (an AMD integrated GPU on ANGLE/D3D11):
 *
 *   "OES_packed_depth_stencil support is required."
 *   "Could not create a WebGL context, ... ErrorMessage = BindToCurrentSequence failed: ."
 *
 * The first is a hard capability gap; the second is the GPU process being
 * unable to serve a context at that moment — a browser hands out only ~16 live
 * WebGL contexts per page, and the main viewport renderer is a separate WebGPU
 * consumer in the same process. Neither is actionable by the user beyond
 * reloading, and neither gets better because a component remounted.
 *
 * Hence a gate rather than a bare probe function: probe once, latch the
 * verdict for the session, ration the reporting, and let each caller paint its
 * own fallback. Module-scope state per gate is deliberate — remounting (the
 * Georeferencing section is a Radix Collapsible; the playground panel unmounts
 * when collapsed) must not re-open the floodgates.
 *
 * Consumers configure a gate with the context attributes THEY actually request,
 * because probe fidelity is the whole point: a lazier attribute set would
 * return "supported" on the very devices this exists for. See
 * `lib/geo/map-webgl-support.ts` and `components/mcp/three-webgl-support.ts`,
 * which own the library-specific error shapes on top of this.
 *
 * Kept free of `posthog-js` and of any renderer library on purpose, so the
 * contract is unit-testable under the Node test runner without a browser or a
 * megabyte of bundle (same discipline as `analytics-scrub.ts`). Reporting is
 * the caller's job; this module only rations it via `takeReportSlot`.
 */

/** A gate's answer. `reason` is present only when `supported` is false. */
export interface WebglVerdict<Reason extends string> {
  supported: boolean;
  reason?: Reason;
}

/** Minimal structural types so the probe can be driven by a fake in tests. */
export interface ProbeContext {
  getExtension(name: string): { loseContext?: () => void } | null;
}
export interface ProbeCanvas {
  getContext(type: string, attributes?: unknown): ProbeContext | null;
}

export interface WebglCapabilityGate<Reason extends string> {
  /** The latched verdict, or `null` if nothing has been determined yet. */
  getVerdict(): WebglVerdict<Reason> | null;
  /**
   * Latch a negative verdict discovered the hard way — by the real
   * construction throwing, or by the context being lost later. Idempotent: the
   * FIRST reason wins, so the originating failure is the one that gets
   * reported.
   */
  markUnsupported(reason: Reason): void;
  /**
   * Claim the once-per-session slot for reporting this failure to error
   * tracking.
   *
   * Returns `true` exactly once. These failures repeat on every remount, and
   * the production evidence is a single user in a single session — enough to
   * show the pattern, and enough to flood the exception quota on a device
   * where the user keeps toggling a panel.
   */
  takeReportSlot(): boolean;
  /**
   * Decide whether the real thing can be constructed, without constructing it.
   *
   * Cheap: a detached canvas, `webgl2` only (both consumers require it), and
   * the context is released immediately via `WEBGL_lose_context`. Releasing is
   * load-bearing, not tidiness: with only ~16 live contexts per page, a probe
   * that leaked one could *cause* the failure it screens for.
   *
   * The probe is an optimisation, never the sole gate: it lets the fallback be
   * the user's first paint instead of a caught throw, and it keeps a
   * half-built canvas out of the caller's container. The caller must still
   * wrap the real construction in `try/catch`, because a probe can pass and
   * the context still be refused a moment later under GPU-process contention —
   * exactly the `BindToCurrentSequence failed` case.
   *
   * When there is no `document` (the Node test runner, SSR) the verdict is
   * optimistic: nothing renders there anyway, and guessing "unsupported" would
   * be a worse default than deferring to the `try/catch`.
   *
   * @param createCanvas Injected canvas factory. Tests only.
   */
  probe(createCanvas?: () => ProbeCanvas | null): WebglVerdict<Reason>;
  /** Reset the session latches. Test seam — not used in production. */
  resetForTests(): void;
}

export interface WebglCapabilityGateOptions<Reason extends string> {
  /**
   * The context attributes the real consumer requests, as faithfully as they
   * can be reproduced. Drift here only costs probe fidelity, never
   * correctness, because the caller still wraps the real construction in
   * `try/catch` — but a lazier set defeats the purpose (see the file header).
   */
  attributes: Readonly<Record<string, unknown>>;
  /** The reason latched when the probe itself cannot get a context. */
  probeFailureReason: Reason;
  /** Short consumer name used in the two `console.warn` paths, e.g. `map`. */
  label: string;
}

const defaultCanvasFactory = (): ProbeCanvas | null =>
  typeof document === 'undefined' ? null : document.createElement('canvas');

export function createWebglCapabilityGate<Reason extends string>(
  options: WebglCapabilityGateOptions<Reason>,
): WebglCapabilityGate<Reason> {
  const supported: WebglVerdict<Reason> = Object.freeze({ supported: true });

  // `null` means "not yet determined". Once set, the verdict stands for the
  // rest of the session: a device that cannot serve a WebGL context will not
  // start doing so because the user re-opened an accordion, and re-probing
  // would burn a context slot each time.
  let verdict: WebglVerdict<Reason> | null = null;
  let reportSlotTaken = false;

  return {
    getVerdict: () => verdict,

    markUnsupported(reason) {
      if (verdict && !verdict.supported) return;
      verdict = { supported: false, reason };
    },

    takeReportSlot() {
      if (reportSlotTaken) return false;
      reportSlotTaken = true;
      return true;
    },

    probe(createCanvas = defaultCanvasFactory) {
      if (verdict) return verdict;

      let gl: ProbeContext | null = null;
      let canvas: ProbeCanvas | null = null;
      try {
        canvas = createCanvas();
        // No DOM to probe with: stay optimistic and let the `try/catch` decide.
        if (!canvas) return (verdict = supported);
        gl = canvas.getContext('webgl2', options.attributes);
      } catch (err) {
        // `getContext` is not specified to throw, but a wedged GPU process has
        // been seen to. Treat a throw exactly like a refusal — and say so,
        // because this branch firing is itself the interesting signal.
        console.warn(`[ifc-lite] ${options.label} WebGL probe threw; treating as unsupported`, err);
        gl = null;
      } finally {
        // Hand the context straight back, on every path including failure.
        try {
          gl?.getExtension('WEBGL_lose_context')?.loseContext?.();
        } catch (err) {
          // Best-effort: never mask the verdict we already have.
          console.warn(`[ifc-lite] could not release the ${options.label} WebGL probe context`, err);
        }
      }

      verdict = gl ? supported : { supported: false, reason: options.probeFailureReason };
      return verdict;
    },

    resetForTests() {
      verdict = null;
      reportSlotTaken = false;
    },
  };
}
