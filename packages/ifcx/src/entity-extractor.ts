/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity Extractor for IFCX
 * Extracts entities from composed nodes and builds EntityTable
 */

import type { ComposedNode, IfcClass } from './types.js';
import { ATTR } from './types.js';
import { buildReachableAttributeIndex, collectIncomingEdgeNames, collectSiblingEdgeNames } from './traversal.js';
import { nodeName } from './names.js';
import { materialDefinitions, typeDefinitions } from './definitions.js';
import { POINTCLOUD_ATTR_KEYS } from '@ifc-lite/pointcloud';
import {
  StringTable,
  EntityTableBuilder,
} from '@ifc-lite/data';
import type { DerivedEntities, EntityTable } from '@ifc-lite/data';

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
  /** What the table says that the file does not (see `DerivedEntities`): the exporter writes the file's classes. */
  derived: DerivedEntities;
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
  const siblingEdgeNames = collectSiblingEdgeNames(composed);
  const geometryIndex = buildReachableAttributeIndex(composed, ATTR.MESH);

  // A type definition is an IfcXType, a material definition an IfcMaterial:
  // IFCX states both as nodes others inherit (see definitions.ts).
  const typeDefs = typeDefinitions(composed);
  const materialDefs = materialDefinitions(composed);

  // First pass: count entities to allocate builder
  let entityCount = materialDefs.size;
  for (const node of composed.values()) {
    const ifcClass = node.attributes.get(ATTR.CLASS) as IfcClass | undefined;
    if (ifcClass || nodeIsPointCloud(node)) {
      entityCount++;
    }
  }

  const retyped = new Map<number, string>();
  const added = new Set<number>();
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
    const typeCode = typeDefs.get(node.path) ?? ifcClass?.code ?? (isPointCloud ? 'IfcGeographicElement' : '');

    const expressId = nextExpressId++;
    if (typeDefs.has(node.path) && ifcClass?.code) retyped.set(expressId, ifcClass.code);
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
    const name = nodeName(node, incomingEdgeNames.get(node.path) ?? [], siblingEdgeNames.get(node.path)) ?? '';

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

  // The materials, after the classed nodes so their ids follow them. Named by
  // the material class code, as hello-wall.ifc names its IfcMaterial CONCRETE.
  for (const [path, code] of materialDefs) {
    if (pathToId.has(path)) continue;
    const expressId = nextExpressId++;
    pathToId.set(path, expressId);
    idToPath.set(expressId, path);
    added.add(expressId);
    builder.add(expressId, 'IfcMaterial', path, code, '', '', false, false);
  }

  return {
    entities: builder.build(),
    derived: { retyped, added },
    pathToId,
    idToPath,
  };
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
