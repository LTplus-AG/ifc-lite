/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decide what an isolate-expansion call site should install into the
 * isolation channel, given the raw ids it was asked to isolate and whatever
 * `cameraCallbacks.resolveHighlightIds` currently answers for them.
 *
 * `resolveHighlightIds` (Viewport's `resolveRenderableIds`) can legitimately
 * return three different things, and a call site cannot tell them apart on
 * its own:
 *   - it is not registered at all (renderer not mounted yet) — the resolver
 *     argument here is `undefined`
 *   - it is registered but geometry has not streamed in yet — it returns
 *     `null` ("cannot answer yet")
 *   - it is registered, geometry is in, and the ids genuinely expand to
 *     nothing renderable — it returns `[]` ("answered: nothing renders")
 *
 * Those three cases need three different policies (table from the #3389
 * review, each row keyed to a branch below):
 *
 *   | resolver               | raw ids have geometry | this function returns          |
 *   |-------------------------|------------------------|--------------------------------|
 *   | absent                  | —                      | raw ids (self-heals once a     |
 *   |                          |                        | resolver mounts and re-runs)   |
 *   | registered, non-empty   | —                      | resolved ∪ raw ids             |
 *   | registered, returns null (streaming) | yes, once meshes land | raw ids, unioned — the caller  |
 *   |                          |                        | applies correctly the moment   |
 *   |                          |                        | the meshes arrive              |
 *   | registered, returns []  | no (geometry-less)     | `null` — leave the isolation    |
 *   |                          |                        | channel untouched              |
 *
 * That last row is right for a ONE-SHOT isolate: the user (or an SDK/embed
 * caller) asked to isolate something, nothing in it renders, and doing
 * nothing beats blanking the viewport. It is WRONG for a channel whose job is
 * to REPLACE the current view — see `resolveIsolationIdsForViewSync` below.
 *
 * IMPORTANT: the `undefined`-resolver and `null`-resolved rows are still a
 * gamble, not a fix. Both union the raw ids into the isolation set on the
 * assumption that geometry will eventually stream in and the ids will start
 * rendering; if it never does (or resolves to nothing), the viewport isolates
 * to ids that never draw and looks the same as before this change. That is
 * "self-heals", not "always correct" — the definitive fix is deferred
 * re-resolution (re-run this call once geometry lands), which this function
 * does not implement. What it does provide is the `null` signal from the
 * resolver, which is the hook a future deferred-resolution pass needs.
 *
 * The one case genuinely fixed here is the last row: a resolver that has
 * already resolved and genuinely found nothing renderable (a geometry-less
 * assembly, `IfcElementAssembly` and friends, with no aggregated part that
 * renders either) must not blank the whole viewport. Isolating `[]` there
 * used to mean "isolate nothing renders", i.e. hide everything already
 * visible — worse than doing nothing at all.
 */
export function resolveIsolationIds(
  resolver: ((ids: number[]) => number[] | null) | undefined,
  rawIds: readonly number[],
): number[] | null {
  if (!resolver) return [...rawIds];
  const resolved = resolver([...rawIds]);
  if (resolved === null) return [...new Set(rawIds)];
  if (resolved.length === 0) return null;
  return [...new Set([...resolved, ...rawIds])];
}

/**
 * Same expansion policy as `resolveIsolationIds`, for the channels that must
 * ASSIGN on every run rather than perform a one-shot user action: the BCF
 * viewpoint apply (`useBCF.ts`) and the anonymized-export 3D preview
 * (`usePreviewIsolation.ts`). Both say "the view is now exactly this set" —
 * a re-sync effect and a "put the viewer into this state" command.
 *
 * For those, "leave the isolation channel untouched" is not a safe no-op: it
 * leaves the PREVIOUS isolation on screen and labels it as the new
 * viewpoint's / the export's contents, while the selection channel next to it
 * is updated to the real set, so highlight and isolation disagree. A blank
 * view (what `main` produced) is wrong too, but it is honestly empty rather
 * than someone else's content mislabelled — so these channels fall back to
 * the raw ids on `[]` and always return a set to install.
 *
 * The expansion win is unchanged: a resolver that DOES expand a geometry-less
 * assembly still contributes its parts, which is the #3338 fix.
 */
export function resolveIsolationIdsForViewSync(
  resolver: ((ids: number[]) => number[] | null) | undefined,
  rawIds: readonly number[],
): number[] {
  return resolveIsolationIds(resolver, rawIds) ?? [...new Set(rawIds)];
}
