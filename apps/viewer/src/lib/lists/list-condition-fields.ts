/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The field vocabulary of a Lists value predicate (#6190), the one place the
 * List-value editor reads which levels, zone modes, axes and operators exist.
 * Stored spellings are the Lists engine's; changing one changes saved lists. */
import { listConditionValueKind, type ConditionOperator, type PropertyCondition } from '@ifc-lite/lists';
import type { ZoneSet } from '@/lib/zones';

export type ConditionSource = PropertyCondition['source'];

/** Offered in the editor's source picker, in this order. */
export const LIST_VALUE_SOURCES: readonly ConditionSource[] = [
  'zone', 'spatial', 'model', 'attribute', 'property', 'quantity', 'material', 'classification', 'geometry',
];

export const SPATIAL_LEVELS = ['Container', 'Storey', 'Building', 'Site', 'Project'] as const;

/** Stored zone display modes; the two volume modes are compared case-insensitively by the engine. */
export const ZONE_MODE_NAME = 'Zone';
export const ZONE_MODE_STRADDLES = 'Straddles';
export const ZONE_MODE_VOLUME_LABEL = 'Volume (mesh)';
export const ZONE_MODE_BREAKDOWN_LABEL = 'Volume breakdown (mesh)';
export const ZONE_MODES = [ZONE_MODE_NAME, ZONE_MODE_STRADDLES, ZONE_MODE_VOLUME_LABEL, ZONE_MODE_BREAKDOWN_LABEL] as const;

export const GEOMETRY_AXES = ['X', 'Y', 'Z'] as const;

/** The operators that can match the value the Lists engine reads for this
 *  source and mode (`listConditionValueKind`): a zone volume offers
 *  comparisons, Straddles only equality and presence. */
export function operatorsFor(source: ConditionSource, mode = ''): ConditionOperator[] {
  switch (listConditionValueKind(source, mode)) {
    case 'number': return ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'exists'];
    case 'any': return ['equals', 'notEquals', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists'];
    case 'texts': return ['contains', 'equals', 'notEquals', 'exists'];
    case 'boolean': return ['equals', 'notEquals', 'exists'];
    case 'text': return ['equals', 'notEquals', 'contains', 'exists'];
  }
}

/** A fresh condition of `source`. A zone condition starts on the first defined
 *  set, so switching to Zone lands on something usable. */
export function defaultConditionFor(source: ConditionSource, zoneSets: readonly ZoneSet[] = []): PropertyCondition {
  switch (source) {
    case 'property': return { source, psetName: '', propertyName: '', operator: 'equals', value: '' };
    case 'quantity': return { source, psetName: '', propertyName: '', operator: 'gt', value: '' };
    case 'material': return { source, propertyName: 'Material', operator: 'contains', value: '' };
    case 'classification': return { source, propertyName: 'Classification', operator: 'contains', value: '' };
    case 'spatial': return { source, propertyName: 'Storey', operator: 'equals', value: '' };
    case 'model': return { source, propertyName: 'Model', operator: 'equals', value: '' };
    case 'zone': return { source, psetName: zoneSets[0]?.id ?? '', propertyName: ZONE_MODE_NAME, operator: 'equals', value: '' };
    case 'geometry': return { source, propertyName: 'X', operator: 'gt', value: '' };
    case 'attribute': return { source, propertyName: 'Name', operator: 'contains', value: '' };
  }
}
