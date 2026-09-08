/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reconciles the "restore lens/Pset/IDS colours" step of the clash-solid
 * presentation (`useClash.ts`'s `focusClash`) with any X-Ray ghosting that
 * presentation just applied.
 *
 * The renderer treats a colour override as a ROUTING decision, not just a
 * tint: an entity carrying a deliberate override (alpha >= 0.2) is promoted
 * from the transparent pipeline to the opaque, depth-writing one, so the
 * overlay paint pass (which uses `depthCompare: 'equal'`) has depth to match
 * (`packages/renderer/src/overlay-routing.ts`). `ghostExceptIds` fades an
 * entity through the transparent-pipeline alpha path
 * (`packages/renderer/src/index.ts`'s `alphaForMesh`/`alphaForBatch`) and
 * does not survive that promotion — a ghosted entity that ALSO carries a
 * lens colour override renders opaque anyway, defeating the ghost.
 *
 * `focusClash` ghosts the whole model (BIMcollab-style) while a clash solid
 * is on screen, then restores the caller's lens colours verbatim. If any
 * lens/Pset/IDS colouring is active, that verbatim restore reintroduces the
 * promotion for every coloured entity, including the two clash parents —
 * exactly the "hard to see" complaint the solid presentation exists to fix.
 *
 * This filters the override map down to only the entities NOT ghosted
 * (`ghostExceptEntities`'s members — X-Ray's "except" set is the one this
 * function's semantics are named after) so the ghost tier always wins for
 * the ghosted entities. `ghostExceptEntities === null` means no ghosting is
 * active — nothing is filtered, since the promotion is not in conflict with
 * anything.
 */
export function restoreOverridesForGhosting(
  overrides: ReadonlyMap<number, readonly [number, number, number, number]> | null,
  ghostExceptEntities: ReadonlySet<number> | null,
): Map<number, [number, number, number, number]> {
  if (!overrides || overrides.size === 0) return new Map();
  const result = new Map<number, [number, number, number, number]>();
  for (const [id, rgba] of overrides) {
    if (ghostExceptEntities === null || ghostExceptEntities.has(id)) {
      result.set(id, [rgba[0], rgba[1], rgba[2], rgba[3]]);
    }
  }
  return result;
}
