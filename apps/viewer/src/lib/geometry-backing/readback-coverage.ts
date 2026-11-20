/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hide/isolate state the renderer's current readback pieces were prepared
 * under (#10264). The renderer's own coverage (`readbackRaycastCovers`) checks
 * the ray and the view only; pieces chosen under other visibility can lack a
 * surface that is now visible, so coverage also requires the same visibility.
 */

export interface ReadbackVisibility { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null }

/** Per renderer: each canvas's pieces and ray coverage are its own. */
const fedBy = new WeakMap<object, { hidden: ReadonlySet<number>; isolated: ReadonlySet<number> | null }>();

const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>) => a.size === b.size && [...a].every((id) => b.has(id));

/** Recorded by the feeder when it hands pieces over; `null` when they are cleared. */
export function recordFedVisibility(renderer: object, visibility: ReadbackVisibility | null): void {
  if (!visibility) { fedBy.delete(renderer); return; }
  fedBy.set(renderer, { hidden: new Set(visibility.hiddenIds ?? []), isolated: visibility.isolatedIds ? new Set(visibility.isolatedIds) : null });
}

/** Whether the current pieces were prepared under exactly `visibility`. */
export function fedUnderVisibility(renderer: object, visibility: ReadbackVisibility): boolean {
  const fed = fedBy.get(renderer);
  if (!fed) return false;
  const isolated = visibility.isolatedIds ?? null;
  if ((fed.isolated === null) !== (isolated === null)) return false;
  return sameSet(fed.hidden, visibility.hiddenIds ?? new Set()) && (isolated === null || sameSet(fed.isolated!, isolated));
}
