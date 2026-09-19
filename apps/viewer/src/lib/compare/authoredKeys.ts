/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authored keys for the viewer's compare adapter (issue #4955): key the
 * comparison on `Tag` or a `Pset.Prop` the model maintains on purpose,
 * instead of GlobalId. Split out of `buildFingerprints.ts` for size.
 */

import {
  EntityExtractor,
  authoredKeyValue,
  extractPropertiesOnDemand,
  parseAuthoredKeySpec,
  type IfcDataStore,
} from '@ifc-lite/parser';
import type { EntityFingerprint } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints.js';

export type ExtractedPropertySets = ReturnType<typeof extractPropertiesOnDemand>;

/** Prefix on a fingerprint key taken from an authored property rather than a GlobalId. */
export const AUTHORED_KEY_PREFIX = 'prop:';

/**
 * local express id -> `prop:<value>` for every entity carrying a non-empty
 * value nobody else does. Resolved in one pass so a value two entities share
 * is refused for both (reported on `duplicateAuthoredKeys`) rather than the
 * diff's first-wins index quietly keeping one. Empty when no spec is given.
 */
export async function resolveAuthoredKeys(
  store: IfcDataStore,
  localIds: Iterable<number>,
  keyProperty: string | undefined,
  duplicateAuthoredKeys?: Map<string, number[]>,
  propertySetsById?: Map<number, ExtractedPropertySets>,
): Promise<Map<number, string>> {
  const keys = new Map<number, string>();
  const spec = keyProperty ? parseAuthoredKeySpec(keyProperty) : undefined;
  if (!spec) return keys;
  const extractor = new EntityExtractor(store.source);
  const owners = new Map<string, number[]>();
  let scanned = 0;
  for (const localId of localIds) {
    let value: string | undefined;
    if (spec.kind === 'property') {
      const sets = extractPropertiesOnDemand(store, localId);
      propertySetsById?.set(localId, sets);
      const raw = sets.find((set) => set.name === spec.pset)
        ?.properties.find((property) => property.name === spec.property)?.value;
      if (raw !== null && raw !== undefined) {
        const text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        if (text.trim()) value = text.trim();
      }
    } else {
      value = authoredKeyValue(store, localId, spec, extractor);
    }
    // Authored-key extraction is a full-model pre-pass. Keep the same
    // responsiveness contract as fingerprint assembly on large files.
    if (++scanned % 1500 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    if (value === undefined) continue;
    const list = owners.get(value);
    if (list) list.push(localId);
    else owners.set(value, [localId]);
  }
  for (const [value, ids] of owners) {
    if (ids.length === 1) keys.set(ids[0], `${AUTHORED_KEY_PREFIX}${value}`);
    else duplicateAuthoredKeys?.set(value, [...(duplicateAuthoredKeys.get(value) ?? []), ...ids]);
  }
  return keys;
}

/** A collision found on either revision invalidates that authored value on
 * both. The first side may already have been built when the second reveals the
 * collision, so repair its key back to GlobalId before diffing. */
export function fallbackPairDuplicateAuthoredKeys(
  sides: readonly { fingerprints: EntityFingerprint<CompareRef>[]; store: IfcDataStore }[],
  duplicates: ReadonlyMap<string, number[]>,
): void {
  if (duplicates.size === 0) return;
  for (const { fingerprints, store } of sides) {
    for (const fingerprint of fingerprints) {
      if (!fingerprint.key.startsWith(AUTHORED_KEY_PREFIX)) continue;
      const value = fingerprint.key.slice(AUTHORED_KEY_PREFIX.length);
      if (!duplicates.has(value)) continue;
      const globalId = store.entities.getGlobalId(fingerprint.ref.localId);
      fingerprint.key = globalId || `missing:${fingerprint.ref.modelId}:${fingerprint.ref.localId}`;
    }
  }
}

/** The Compare panel's duplicate-authored-key note, as DATA rather than an
 *  assembled English sentence — issue #4989 review: a lib file outside
 *  `apps/viewer/src/components` sits under the i18n literal gate's radar,
 *  but baking prose here just moves the untranslatable string one hop, it
 *  does not remove it. The component (`CompareKeyProperty.tsx`) turns this
 *  into text via `t('compareKeyProperty.duplicateNote', …)`. */
export interface DuplicateAuthoredKeyInfo {
  /** Total authored values that collided (the true count, not `shown.length`). */
  count: number;
  /** The first few colliding values, for display. */
  shown: string[];
  /** Did `shown` have to be truncated? */
  truncated: boolean;
}

/**
 * The Compare panel's duplicate-authored-key info for a non-empty
 * `duplicateAuthoredKeys` map: how many authored values fell back to
 * GlobalId, and the first few so the user can see whether it's a real
 * collision or an obviously-blank sentinel value repeated across the
 * model. `null` when the map is empty (nothing to say).
 */
export function duplicateAuthoredKeyInfo(
  duplicates: ReadonlyMap<string, number[]>,
): DuplicateAuthoredKeyInfo | null {
  if (duplicates.size === 0) return null;
  const values = [...duplicates.keys()];
  return { count: duplicates.size, shown: values.slice(0, 5), truncated: values.length > 5 };
}
