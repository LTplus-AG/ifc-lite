/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Membership of the `webgl_unavailable` family (the kind is declared, with the
 * rest of the taxonomy, in ./load-errors.ts).
 *
 * ONE device condition, two libraries. The browser refuses a WebGL context to
 * MapLibre (the location minimap, #2354) or to three.js (either `/mcp` scene,
 * #2458); both surfaces probe once, latch the verdict and degrade to a static
 * fallback through the shared gate in ./webgl-capability.ts, and both report it
 * as a handled exception. What this module decides is that those reports land
 * in the SAME analytics issue instead of one per library, per wording and per
 * deploy — and, because `webgl_unavailable` is in `BENIGN_ERROR_KINDS`
 * (./analytics-scrub.ts), at `warning` rather than `error`.
 *
 * The whole family lives here so that the SET is visible in one read: a third
 * GPU surface adds an arm to {@link isWebglUnavailable}, rather than a matcher
 * somewhere else that nobody thinks to group. Membership is by MESSAGE, not by
 * who caught it.
 *
 * EVERY arm is anchored or structural; none is a bare `includes`. That is a
 * property of the whole boolean and has to be checked as one, because this
 * predicate hands out both a shared fingerprint and a benign severity: a single
 * loose arm is enough to relabel a real bug of ours as a dead GPU and bury it
 * in an issue nobody triages (#2354). Adding an arm here means anchoring it.
 *
 * MapLibre's wordings are IMPORTED rather than restated: a second copy would
 * drift on the next upgrade, and `lib/geo/map-webgl-support.ts` owns them for
 * `lib/analytics-scrub.ts` too. That module imports no renderer library, so
 * this adds no dependency.
 */

import { isWebglContextCreationError } from './geo/map-webgl-support.js';

/**
 * The same device refusal, reached through three.js instead of MapLibre.
 *
 * `WebGLRenderer`'s constructor asks the canvas for `webgl2` and throws one of
 * exactly two authored messages when the browser says no (three@0.185.1):
 *
 *   'THREE.WebGLRenderer: Error creating WebGL context.'
 *   'THREE.WebGLRenderer: Error creating WebGL context with your selected attributes.'
 *
 * plus the third that `components/mcp/three-webgl-support.ts` synthesises when
 * its pre-flight probe answers before three is ever constructed — the arm that
 * fires FIRST on a device with no `webgl2`, and therefore the one production
 * mostly sees.
 *
 * Claimed here only because #2401 changed what these mean. #2354 deliberately
 * left them out: back then they escaped a mount effect and took the whole
 * `/mcp` route down through `ChunkErrorBoundary`, and folding a page-killing
 * crash into the benign minimap family would have hidden it. Both `/mcp` scenes
 * now mount behind `useThreeScene`, the only `WebGLRenderer` construction sites
 * in this app, so these strings can only arrive as the handled, one-per-session
 * degradation the minimap already files. Same device condition, same
 * fingerprint, and the same `warning` severity — `webgl_unavailable` is in
 * `BENIGN_ERROR_KINDS`, so this also stops one dead panel competing with real
 * breakage on the error-level list. `context` / `three_surface` still separate
 * the two surfaces inside the issue.
 *
 * ANCHORED, like every matcher here, and STRICTER than
 * `isThreeWebglContextError` in `three-webgl-support.ts`, which prefix-matches:
 * that one decides whether to degrade one panel and is recoverable when it
 * over-matches; this one hands out a shared fingerprint and is not.
 */
const THREE_CONTEXT_REFUSAL = new RegExp(
  '^\\s*THREE\\.WebGLRenderer: Error creating WebGL context'
  + '(?: with your selected attributes)?\\.'
  // The pre-flight suffix, kept in step with `threeProbeFailureError()`. A
  // drift canary in three-webgl-support.test.ts classifies that function's
  // real output, so a reworded probe cannot silently fall out of the family.
  + '(?: \\(pre-flight probe\\))?\\s*$',
);

function isThreeContextRefusal(message: string): boolean {
  return THREE_CONTEXT_REFUSAL.test(message);
}

/**
 * Is this error the device refusing a WebGL context, to either library?
 *
 * Takes the throwable AND its stringified message because the two arms key on
 * different things: MapLibre v6 identifies its failure by the error's `name` as
 * well as by its wording, while `WebGLRenderer` throws a plain `Error` whose
 * message is all there is. The message is passed in rather than re-derived so
 * that this sees exactly what `classifyLoadError` classified.
 */
export function isWebglUnavailable(err: unknown, message: string): boolean {
  return isWebglContextCreationError(err) || isThreeContextRefusal(message);
}
