/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Curated SQL template library for the advanced search modal.
 *
 * The catalog targets the views + tables that `DuckDBIntegration`
 * registers during init (see `packages/query/src/duckdb-integration.ts`):
 *   tables: entities, properties, quantities, relationships
 *   views:  walls, doors, windows, slabs, columns, beams, spaces,
 *           entity_properties, entity_quantities
 *
 * Every template is a working query against that schema. Clicking one
 * in the UI replaces the editor contents and auto-runs — the gallery is
 * the primary onboarding path for users who don't know SQL yet.
 */

export interface SqlTemplate {
  id: string;
  label: string;
  description: string;
  sql: string;
}

const TEMPLATES: readonly SqlTemplate[] = [
  {
    id: 'all-walls',
    label: 'All walls',
    description: 'Every wall entity with its GlobalId and name. Good first query.',
    sql: [
      '-- Every wall in the active model.',
      'SELECT express_id, global_id, name',
      'FROM entities',
      "WHERE type = 'IfcWall' OR type = 'IfcWallStandardCase'",
      'ORDER BY name',
      'LIMIT 500;',
    ].join('\n'),
  },
  {
    id: 'external-walls',
    label: 'External walls',
    description: 'Walls whose Pset_WallCommon.IsExternal is true.',
    sql: [
      '-- External walls by property value.',
      'SELECT e.express_id, e.global_id, e.name',
      'FROM entities e',
      'JOIN properties p ON p.entity_id = e.express_id',
      "WHERE e.type IN ('IfcWall', 'IfcWallStandardCase')",
      "  AND p.pset_name = 'Pset_WallCommon'",
      "  AND p.prop_name = 'IsExternal'",
      '  AND p.value_bool = true',
      'LIMIT 500;',
    ].join('\n'),
  },
  {
    id: 'entities-by-type-count',
    label: 'Entity counts by IFC type',
    description: 'Histogram of how many entities of each IFC type exist.',
    sql: [
      '-- Entity counts by IFC type, descending.',
      'SELECT type, COUNT(*) AS count',
      'FROM entities',
      'GROUP BY type',
      'ORDER BY count DESC',
      'LIMIT 50;',
    ].join('\n'),
  },
  {
    id: 'doors-fire-rating',
    label: 'Doors with fire rating',
    description: 'Doors that declare a FireRating property.',
    sql: [
      '-- Doors with any declared FireRating value.',
      'SELECT e.express_id, e.global_id, e.name,',
      '       p.value_string AS fire_rating',
      'FROM entities e',
      'JOIN properties p ON p.entity_id = e.express_id',
      "WHERE e.type = 'IfcDoor'",
      "  AND p.prop_name = 'FireRating'",
      'ORDER BY fire_rating, e.name',
      'LIMIT 500;',
    ].join('\n'),
  },
  {
    id: 'spaces-area',
    label: 'Spaces with Qto_SpaceBaseQuantities.GrossFloorArea',
    description: 'Space entities and their gross floor area from quantities.',
    sql: [
      '-- Spaces with a GrossFloorArea quantity.',
      'SELECT e.express_id, e.global_id, e.name,',
      '       q.value AS gross_floor_area',
      'FROM entities e',
      'JOIN quantities q ON q.entity_id = e.express_id',
      "WHERE e.type = 'IfcSpace'",
      "  AND q.qset_name = 'Qto_SpaceBaseQuantities'",
      "  AND q.quantity_name = 'GrossFloorArea'",
      'ORDER BY gross_floor_area DESC',
      'LIMIT 200;',
    ].join('\n'),
  },
  {
    id: 'missing-pset',
    label: 'Entities missing a required Pset',
    description:
      'Walls that do NOT declare a Pset_WallCommon — useful for QA / IDS prep.',
    sql: [
      '-- Walls that never declare Pset_WallCommon.',
      'SELECT e.express_id, e.global_id, e.name',
      'FROM entities e',
      'WHERE e.type IN (\'IfcWall\', \'IfcWallStandardCase\')',
      '  AND e.express_id NOT IN (',
      '    SELECT entity_id FROM properties',
      "    WHERE pset_name = 'Pset_WallCommon'",
      '  )',
      'LIMIT 500;',
    ].join('\n'),
  },
  {
    id: 'pset-names-available',
    label: 'Pset names present in the model',
    description: 'Distinct Pset names used anywhere + how many entities declare each.',
    sql: [
      '-- Distinct Pset names used in the model.',
      'SELECT pset_name, COUNT(DISTINCT entity_id) AS entity_count',
      'FROM properties',
      "WHERE pset_name <> ''",
      'GROUP BY pset_name',
      'ORDER BY entity_count DESC',
      'LIMIT 100;',
    ].join('\n'),
  },
  {
    id: 'entity-properties-lookup',
    label: 'All properties for a single GlobalId',
    description: 'Every property declared on one specific entity — fill in the GUID.',
    sql: [
      '-- Replace <GUID> with the 22-char IFC GlobalId you care about.',
      'SELECT p.pset_name, p.prop_name, p.prop_type,',
      '       p.value_string, p.value_real, p.value_int, p.value_bool',
      'FROM entities e',
      'JOIN properties p ON p.entity_id = e.express_id',
      "WHERE e.global_id = '<GUID>'",
      'ORDER BY p.pset_name, p.prop_name;',
    ].join('\n'),
  },
];

export function listSqlTemplates(): readonly SqlTemplate[] {
  return TEMPLATES;
}

export function getSqlTemplate(id: string): SqlTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
