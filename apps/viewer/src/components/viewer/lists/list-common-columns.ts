/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ENTITY_ATTRIBUTES, type ColumnDefinition } from '@ifc-lite/lists';

/** Column descriptor shared by the quick-add grid. */
interface CommonColumn {
  id: string;
  source: ColumnDefinition['source'];
  /** Zone-SET id for `source: 'zone'` columns; unused otherwise. */
  psetName?: string;
  propertyName: string;
  label: string;
}

/**
 * The first-class columns: built-in attributes plus the spatial / semantic
 * columns. Surfaced as a flat grid so Material / Classification / Container /
 * Storey / Site / Building / Project / Model are as reachable as Name / Class —
 * not buried in a collapsed group. Container is the element's IMMEDIATE spatial
 * container (Bonsai's "container"): the direct IfcRelContainedInSpatialStructure
 * parent, at whatever level — the storey, or for bridges/roads the
 * IfcBridgePart / IfcRoadPart / IfcSpatialZone it sits in. Site / Building /
 * Project / Model identify which federated file (and where in its spatial tree)
 * each row comes from, so a list over several models can be grouped and sorted
 * by source (issue #1591).
 */
export const COMMON_COLUMNS: CommonColumn[] = [
  ...ENTITY_ATTRIBUTES.map((a): CommonColumn => ({
    id: `attr-${a.toLowerCase()}`,
    source: 'attribute',
    propertyName: a,
    label: a,
  })),
  { id: 'col-material', source: 'material', propertyName: 'Material', label: 'Material' },
  { id: 'col-classification', source: 'classification', propertyName: 'Classification', label: 'Classification' },
  { id: 'col-container', source: 'spatial', propertyName: 'Container', label: 'Container' },
  { id: 'col-storey', source: 'spatial', propertyName: 'Storey', label: 'Storey' },
  { id: 'col-building', source: 'spatial', propertyName: 'Building', label: 'Building' },
  { id: 'col-site', source: 'spatial', propertyName: 'Site', label: 'Site' },
  { id: 'col-project', source: 'spatial', propertyName: 'Project', label: 'Project' },
  { id: 'col-triangle-count', source: 'geometry', propertyName: 'TriangleCount', label: 'Triangles' },
  { id: 'col-model', source: 'model', propertyName: 'Model', label: 'Model' },
  ...(['X', 'Y', 'Z'] as const).map((axis): CommonColumn => ({ id: `col-world-${axis.toLowerCase()}`, source: 'geometry', propertyName: axis, label: `World ${axis}` })),
];

