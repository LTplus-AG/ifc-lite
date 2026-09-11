/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The visibility half of a BCF viewpoint capture (`useBCF.ts`
 * `createViewpointFromState`): turn the viewer's hidden / isolated entity ids
 * into the `visibleGuids` / `hiddenGuids` a viewpoint records, and say what
 * could not be recorded (#4509, #4529).
 *
 * BCF addresses components by IfcGuid only. An entity with none falls in one
 * of two classes, and they are handled differently:
 *
 *  - VIEWER-ONLY (point cloud, synthetic id, unregistered model): it does not
 *    exist in the recipient's model. An isolate that mixes such entities with
 *    IFC ones records the nameable allowlist and reports the count — "hiding"
 *    an entity the recipient does not have is vacuous, while omitting the
 *    whole component would turn a focused topic into "show the whole model".
 *  - PENDING (a registered model whose metadata has not hydrated yet): the
 *    entity is real IFC and will resolve later; an allowlist written now would
 *    tell the recipient it was hidden. The capture is refused for the moment
 *    (component omitted, author told to retry) rather than recorded wrongly.
 *
 * An isolate with NO nameable member is the one shape whose only reading would
 * be "NOTHING is visible" (`DefaultVisibility="false"`, no exceptions), so it
 * is omitted rather than asserted; a genuinely empty isolate (active, matches
 * nothing — #4509) records exactly that: an empty allowlist. The hide-list can
 * only under-hide, which is the safe direction for a recipient, so its
 * shortfall is logged, not toasted.
 */

/** Resolves a global entity id to its IFC GlobalId, or nothing when the entity has none. */
export type GuidResolver = (globalId: number) => string | null | undefined;
/** True when the entity belongs to a registered model whose metadata is still loading. */
export type PendingPredicate = (globalId: number) => boolean;

export interface VisibilityNotice {
  /** Entities the capture could not name. */
  unnameable: number;
  total: number;
  kind: 'isolated' | 'hidden';
  /** The visibility component was left out entirely (nothing nameable, or a pending model). */
  omitted: boolean;
  /** At least one un-nameable entity is real IFC still loading its metadata. */
  pending: boolean;
  /** The un-nameable global ids, for the console. */
  ids: number[];
}

export interface VisibilityCapture {
  /** Isolation allowlist (`defaultVisibility: false`); `undefined` = no isolation channel to record. */
  visibleGuids: string[] | undefined;
  /** Hide-list (`defaultVisibility: true`); `undefined` = nothing hidden to record. */
  hiddenGuids: string[] | undefined;
  /** What the capture could not name; `null` when everything was recorded. */
  notice: VisibilityNotice | null;
}

/**
 * `isolatedEntities` is meaningfully nullable: `null` = no isolation channel,
 * a Set — EMPTY included — = an active isolation (the convention
 * `packages/renderer/src/entity-visibility.ts` enforces). Isolation wins
 * over the hide-list, as BCF's `Visibility` element can express only one.
 */
export function captureVisibility(
  isolatedEntities: ReadonlySet<number> | null,
  hiddenEntities: ReadonlySet<number>,
  resolve: GuidResolver,
  isPending: PendingPredicate = () => false,
): VisibilityCapture {
  if (isolatedEntities !== null) {
    const { guids, unnameable } = nameable(isolatedEntities, resolve);
    const pending = unnameable.some(isPending);
    const omitted = pending || (isolatedEntities.size > 0 && guids.length === 0);
    const notice: VisibilityNotice | null =
      unnameable.length > 0 ? { unnameable: unnameable.length, total: isolatedEntities.size, kind: 'isolated', omitted, pending, ids: unnameable } : null;
    return { visibleGuids: omitted ? undefined : guids, hiddenGuids: undefined, notice };
  }
  if (hiddenEntities.size === 0) return { visibleGuids: undefined, hiddenGuids: undefined, notice: null };
  const { guids, unnameable } = nameable(hiddenEntities, resolve);
  return {
    visibleGuids: undefined,
    hiddenGuids: guids.length > 0 ? guids : undefined,
    notice:
      unnameable.length > 0
        ? { unnameable: unnameable.length, total: hiddenEntities.size, kind: 'hidden', omitted: guids.length === 0, pending: unnameable.some(isPending), ids: unnameable }
        : null,
  };
}

/**
 * The author-facing sentence for an ISOLATION notice, or `null` when the
 * author need not be interrupted (a hide-list shortfall only under-hides).
 */
export function describeVisibilityNotice(notice: VisibilityNotice): string | null {
  if (notice.kind !== 'isolated') return null;
  const n = notice.unnameable;
  const elements = n === 1 ? 'element' : 'elements';
  if (notice.pending) {
    return `Viewpoint visibility not recorded: ${n} of ${notice.total} isolated ${elements} belong to a model that is still loading — try again in a moment.`;
  }
  if (notice.omitted) {
    return 'Viewpoint saved without its visibility: the isolated elements have no IFC GlobalId to record.';
  }
  return `Viewpoint visibility is partial: ${n} of ${notice.total} isolated ${elements} ${n === 1 ? 'has' : 'have'} no IFC GlobalId and will appear hidden to recipients.`;
}

function nameable(ids: ReadonlySet<number>, resolve: GuidResolver): { guids: string[]; unnameable: number[] } {
  const guids: string[] = [];
  const unnameable: number[] = [];
  for (const id of ids) {
    const guid = resolve(id);
    if (guid) guids.push(guid);
    else unnameable.push(id);
  }
  return { guids, unnameable };
}
