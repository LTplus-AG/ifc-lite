/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity Extractor for IFCX
 * Extracts entities from composed nodes and builds EntityTable
 */

import type { ComposedNode, IfcClass } from './types.js';
import { ATTR } from './types.js';
import { buildReachableAttributeIndex, collectIncomingEdgeNames } from './traversal.js';
import { POINTCLOUD_ATTR_KEYS } from '@ifc-lite/pointcloud';
import {
  StringTable,
  EntityTableBuilder,
} from '@ifc-lite/data';
import type { EntityTable } from '@ifc-lite/data';

/**
 * Promote a node to a first-class entity when it carries any of the
 * buildingSMART IFC5 point cloud schemas, even without `bsi::ifc::class`.
 * The Point_Cloud_*.ifcx fixtures authored by Arjo Nagelhout carry only
 * USD `xformop` + one of those custom schemas.
 */
function nodeIsPointCloud(node: ComposedNode): boolean {
  for (const key of POINTCLOUD_ATTR_KEYS) {
    if (node.attributes.has(key)) return true;
  }
  return false;
}

export interface EntityExtractionResult {
  entities: EntityTable;
  pathToId: Map<string, number>;
  idToPath: Map<number, string>;
}

/**
 * Extract entities from composed IFCX nodes.
 *
 * Mapping:
 * - path -> expressId (synthetic, auto-incrementing)
 * - bsi::ifc::class.code -> typeEnum
 * - children hierarchy -> spatial structure
 */
export function extractEntities(
  composed: Map<string, ComposedNode>,
  strings: StringTable
): EntityExtractionResult {
  const pathToId = new Map<string, number>();
  const idToPath = new Map<number, string>();
  const incomingEdgeNames = collectIncomingEdgeNames(composed);
  const geometryIndex = buildReachableAttributeIndex(composed, ATTR.MESH);

  // First pass: count entities to allocate builder
  let entityCount = 0;
  for (const node of composed.values()) {
    const ifcClass = node.attributes.get(ATTR.CLASS) as IfcClass | undefined;
    if (ifcClass || nodeIsPointCloud(node)) {
      entityCount++;
    }
  }

  const builder = new EntityTableBuilder(Math.max(entityCount, 100), strings);
  let nextExpressId = 1;

  // Second pass: extract entities
  for (const node of composed.values()) {
    const ifcClass = node.attributes.get(ATTR.CLASS) as IfcClass | undefined;
    const isPointCloud = nodeIsPointCloud(node);
    if (!ifcClass && !isPointCloud) continue;
    // Pointcloud nodes that omit bsi::ifc::class get a synthetic class
    // — IfcGeographicElement is the closest IFC4.3 fit for "georeferenced
    // scan attached to a project". Real IFC class wins when present.
    const typeCode = ifcClass?.code ?? (isPointCloud ? 'IfcGeographicElement' : '');

    const expressId = nextExpressId++;
    pathToId.set(node.path, expressId);
    idToPath.set(expressId, node.path);

    // Extract name from attributes. No source attribute and no usable
    // incoming edge name means the entity genuinely has no Name — stay
    // '' (the STEP parser's own convention for a missing Name, see
    // `columnar-parser.ts`'s `addEntityBatch`) rather than fabricating one
    // from a slice of the internal IFCX path, which reads as a plausible
    // short name/code no source data backs and pre-empts the viewer's own
    // "Name absent" display convention (`getName(id) || '${type} #${id}'`
    // in treeDataBuilder.ts).
    const name = extractName(node, incomingEdgeNames.get(node.path) ?? []) ?? '';

    // Extract description from attributes (writer.ts writes it to the same
    // `bsi::ifc::prop::Description` attribute it writes name to under
    // `bsi::ifc::prop::Name` — see writeEntities's "IFC5 uses bsi::ifc::prop::
    // namespace for name/description" comment). Without this, `description`
    // survived nowhere on a round trip through an IFCX archive.
    const description = extractDescription(node);

    // Check if has geometry — points count too so the hierarchy panel
    // shows a geometry indicator for scan entries.
    const hasGeometry = (geometryIndex.get(node.path) ?? false) || isPointCloud;

    // Check if this is a type definition
    const isType = typeCode.toUpperCase().endsWith('TYPE');

    // Extract objectType the same way. It used to be filled with `typeCode`,
    // which fabricated an ObjectType for every IFCX-sourced entity: every
    // wall reported ObjectType 'IfcWall', indistinguishable from an authored
    // value to every consumer that reads it (CSV/Parquet export, the query
    // engine's ObjectType column, IDS's `getObjectType`, the lens summary
    // line). Absent now means '', the same default the STEP parser uses for
    // an entity with no ObjectType (`addEntityBatch` in
    // packages/parser/src/columnar-parser.ts).
    const objectType = extractObjectType(node);

    // Add entity to builder
    builder.add(
      expressId,
      typeCode,
      node.path, // Use path as GlobalId
      name,
      description,
      objectType,
      hasGeometry,
      isType
    );
  }

  return {
    entities: builder.build(),
    pathToId,
    idToPath,
  };
}

/**
 * Extract entity name from node attributes.
 */
function extractName(node: ComposedNode, incomingEdgeNames: string[]): string | null {
  // Try direct IFC name attribute (written by IFCX exporter/writer)
  const ifcName = node.attributes.get('bsi::ifc::name');
  if (typeof ifcName === 'string') return ifcName;

  // Try common property patterns
  const name = node.attributes.get('bsi::ifc::prop::Name');
  if (typeof name === 'string') return name;

  const typeName = node.attributes.get('bsi::ifc::prop::TypeName');
  if (typeof typeName === 'string') return typeName;

  const objectName = node.attributes.get('bsi::ifc::prop::ObjectName');
  if (typeof objectName === 'string') return objectName;

  // Fall back to readable incoming edge names when the entity itself has no name.
  for (const edgeName of incomingEdgeNames) {
    if (edgeName !== node.path && !edgeName.match(/^[0-9a-f-]{36}$/i)) {
      return edgeName;
    }
  }

  return null;
}

/**
 * Extract entity description from node attributes. Mirrors `extractName`'s
 * direct-attribute lookup, but has no incoming-edge-name fallback: an edge
 * name is a plausible stand-in for a missing *name*, not a description.
 */
function extractDescription(node: ComposedNode): string {
  const description = node.attributes.get('bsi::ifc::prop::Description');
  return typeof description === 'string' ? description : '';
}

/**
 * Extract entity ObjectType from node attributes.
 *
 * buildingSMART's official v5a `prop` schema
 * (packages/export/src/__fixtures__/schemas/prop@v5a.ifcx) defines
 * Name/Description/UsageType/TypeName but no ObjectType, so a third-party
 * IFCX archive usually carries nothing here. ifc-lite's own collab seed does
 * write the key — apps/viewer/src/lib/collab/step-seed.ts emits
 * `bsi::ifc::prop::ObjectType` for every STEP entity that has one — and that
 * snapshot is read back through `extractEntities` (`snapshotToIfcx` →
 * `parseIfcxViewerModel`), so reading the key is what carries ObjectType
 * across a collab round trip instead of dropping it.
 */
function extractObjectType(node: ComposedNode): string {
  const objectType = node.attributes.get('bsi::ifc::prop::ObjectType');
  return typeof objectType === 'string' ? objectType : '';
}
