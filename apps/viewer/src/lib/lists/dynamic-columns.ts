/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Quick-add list columns for user-defined data, appended after the static
 * first-class columns: per zone set (#1810, #2508) its zone and mesh volume,
 * per custom grouping (#8425) the element's group.
 */

import type { ColumnDefinition } from '@ifc-lite/lists';
import type { Lens } from '@ifc-lite/lens';
import type { ZoneSet } from '@/lib/zones';
import { isGroupingLens } from '@/lib/lens/custom-groupings';
import { ZONE_MODE_VOLUME_LABEL } from './list-condition-fields';

export type QuickColumn = Pick<ColumnDefinition, 'id' | 'source' | 'psetName' | 'propertyName'> & { label: string };

export function dynamicListColumns(zoneSets: readonly Pick<ZoneSet, 'id' | 'name'>[], lenses: readonly Lens[]): QuickColumn[] {
  return [
    ...zoneSets.flatMap((zs): QuickColumn[] => [
      { id: `col-zone-${zs.id}`, source: 'zone', psetName: zs.id, propertyName: 'Zone', label: `Zone: ${zs.name}` },
      // The BASIS is in the mode name, so it survives into the column tag and
      // the header: a zone volume off a net wall and one off a gross wall are
      // not comparable numbers.
      { id: `col-zonevol-${zs.id}`, source: 'zone', psetName: zs.id, propertyName: ZONE_MODE_VOLUME_LABEL, label: `Zone volume: ${zs.name}` },
    ]),
    // Name plus id hint, like the `customGrouping` rule, so the column follows a renamed Lens.
    ...lenses.filter(isGroupingLens).map((lens): QuickColumn => ({
      id: `col-grouping-${lens.id}`, source: 'customGrouping', psetName: lens.id, propertyName: lens.name, label: `Grouping: ${lens.name}`,
    })),
  ];
}
