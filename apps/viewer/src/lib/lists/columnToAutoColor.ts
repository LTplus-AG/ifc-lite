/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Maps a list ColumnDefinition to a lens AutoColorSpec.
 * This bridges the lists feature (column-based data tables) with
 * the lens feature (3D coloring) by converting column metadata
 * into the auto-color specification used by the lens engine.
 */

import type { ColumnDefinition } from '@ifc-lite/lists';
import type { AutoColorSpec } from '@ifc-lite/lens';

/**
 * Convert a list column definition to an auto-color spec.
 *
 * @param col - Column definition from a list configuration
 * @returns AutoColorSpec for the lens engine
 */
export function columnToAutoColor(col: ColumnDefinition): AutoColorSpec {
  switch (col.source) {
    case 'attribute':
      if (col.propertyName === 'Class') return { source: 'ifcType' };
      return { source: 'attribute', propertyName: col.propertyName };
    case 'property':
      return { source: 'property', psetName: col.psetName, propertyName: col.propertyName };
    case 'quantity':
      return { source: 'quantity', psetName: col.psetName, propertyName: col.propertyName };
    case 'material':
      return { source: 'material' };
    case 'classification':
      // psetName doubles as a classification-system filter on both sides of
      // the bridge (see ColumnDefinition.psetName and AutoColorSpec.psetName).
      return { source: 'classification', psetName: col.psetName };
    case 'model':
      return { source: 'model' };
    // 'spatial' and 'zone' columns have no AutoColorSpec equivalent — fall
    // back to ifcType rather than silently mis-coloring by a container/zone
    // value the lens engine can't actually group by.
    default:
      return { source: 'ifcType' };
  }
}
