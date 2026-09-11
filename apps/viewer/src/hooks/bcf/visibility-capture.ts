/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The visibility half of a BCF viewpoint capture (`useBCF.ts`
 * `createViewpointFromState`): turn the viewer's hidden / isolated entity ids
 * into the `visibleGuids` / `hiddenGuids` a viewpoint records, and say what
 * could not be recorded.
 *
 * BCF can only ever address components by IfcGuid, so a viewer-only entity —
 * a point cloud, a synthetic id, an unregistered model — does not exist in
 * the recipient's model and is simply not recordable. The capture therefore
 * writes the allowlist / hide-list it CAN name (#4529):
 *
 *  - an isolate with some un-nameable members records the nameable ones and
 *    reports the count; "hiding" an entity the recipient does not have is
 *    vacuous, while omitting the whole component would turn a focused topic
 *    into "show the whole model";
 *  - an isolate with NO nameable members is the one shape whose only reading
 *    would be "NOTHING is visible" (`DefaultVisibility="false"` with no
 *    exceptions), so it is omitted rather than asserted — the author is told;
 *  - an isolate that is genuinely empty (active, matches nothing — #4509)
 *    records exactly that: an empty allowlist.
 */

/** Resolves a global entity id to its IFC GlobalId, or nothing when the entity has none. */
export type GuidResolver = (globalId: number) => string | null | undefined;

export interface VisibilityCapture {
  /** Isolation allowlist (`defaultVisibility: false`); `undefined` = no isolation channel to record. */
  visibleGuids: string[] | undefined;
  /** Hide-list (`defaultVisibility: true`); `undefined` = nothing hidden to record. */
  hiddenGuids: string[] | undefined;
  /** What the capture could not name, for the console and the author. `null` when everything was recorded. */
  notice: { unnameable: number; total: number; kind: 'isolated' | 'hidden'; omitted: boolean } | null;
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
): VisibilityCapture {
  if (isolatedEntities !== null) {
    const guids = nameable(isolatedEntities, resolve);
    const unnameable = isolatedEntities.size - guids.length;
    if (isolatedEntities.size > 0 && guids.length === 0) {
      // Nothing on screen can be named: omit rather than claim "nothing visible".
      return { visibleGuids: undefined, hiddenGuids: undefined, notice: { unnameable, total: isolatedEntities.size, kind: 'isolated', omitted: true } };
    }
    return {
      visibleGuids: guids, // an empty isolate records an empty allowlist on purpose
      hiddenGuids: undefined,
      notice: unnameable > 0 ? { unnameable, total: isolatedEntities.size, kind: 'isolated', omitted: false } : null,
    };
  }
  if (hiddenEntities.size === 0) return { visibleGuids: undefined, hiddenGuids: undefined, notice: null };
  const guids = nameable(hiddenEntities, resolve);
  const unnameable = hiddenEntities.size - guids.length;
  return {
    visibleGuids: undefined,
    hiddenGuids: guids.length > 0 ? guids : undefined,
    notice: unnameable > 0 ? { unnameable, total: hiddenEntities.size, kind: 'hidden', omitted: guids.length === 0 } : null,
  };
}

/** The author-facing sentence for a capture notice. */
export function describeVisibilityNotice(notice: NonNullable<VisibilityCapture['notice']>): string {
  const what = notice.kind === 'isolated' ? 'isolated' : 'hidden';
  if (notice.omitted) {
    return `Viewpoint saved without its visibility: the ${what} elements have no IFC GlobalId to record.`;
  }
  return `Viewpoint saved with partial visibility: ${notice.unnameable} of ${notice.total} ${what} elements have no IFC GlobalId and are not recorded.`;
}

function nameable(ids: ReadonlySet<number>, resolve: GuidResolver): string[] {
  const guids: string[] = [];
  for (const id of ids) {
    const guid = resolve(id);
    if (guid) guids.push(guid);
  }
  return guids;
}
