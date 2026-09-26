/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Read one persisted v1 or v2 lens rule without silently losing a condition
 * this build cannot express (#5896). Used by localStorage, JSON import and
 * flavor snapshots so the three entry paths cannot drift. */
import type { LensCriteria, LensRule } from '@ifc-lite/lens';
import { isFilterGroup, type FilterGroup } from '@ifc-lite/rules';
import { legacyCriteriaToFilterGroups } from './legacy-criteria-to-filter-groups.js';

/** Staged v2 shape; the final stack makes this the published LensRule shape. */
export type MigratedLensRule = Omit<LensRule, 'criteria'> & {
  groups: FilterGroup[];
  unreadableLegacy?: { criteria: unknown; reason: string };
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function migrateSavedLensRule(input: unknown): MigratedLensRule | null {
  if (!record(input)
    || typeof input.id !== 'string'
    || typeof input.name !== 'string'
    || typeof input.enabled !== 'boolean'
    || (input.action !== 'colorize' && input.action !== 'hide' && input.action !== 'transparent')
    || typeof input.color !== 'string') return null;

  const core = {
    id: input.id, name: input.name, enabled: input.enabled,
    action: input.action as LensRule['action'], color: input.color,
  };
  if (Array.isArray(input.groups)) {
    const groups: FilterGroup[] = input.groups.every(isFilterGroup) ? input.groups : [];
    if (groups.length === 0 && input.groups.length > 0) {
      return { ...core, groups, unreadableLegacy: {
        criteria: input.groups, reason: 'Saved filter groups are unreadable',
      } };
    }
    const prior = input.unreadableLegacy;
    return record(prior) && typeof prior.reason === 'string' && 'criteria' in prior
      ? { ...core, groups, unreadableLegacy: { criteria: prior.criteria, reason: prior.reason } }
      : { ...core, groups };
  }

  if (!record(input.criteria) || typeof input.criteria.type !== 'string') return null;
  const criteria = input.criteria as unknown as LensCriteria;
  const converted = legacyCriteriaToFilterGroups(criteria);
  return converted.status === 'readable'
    ? { ...core, groups: converted.groups }
    : { ...core, groups: [], unreadableLegacy: { criteria, reason: converted.reason } };
}
