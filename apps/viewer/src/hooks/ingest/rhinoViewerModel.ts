/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shallow adapter between `readRhino3dm`'s `RhinoImport` and the viewer:
 * data tables through `buildTabularDataStore` plus `MeshData[]`, returned as
 * the same `ViewerModelPayload` `parseIfcxViewerModel` returns, so a `.3dm`
 * goes through `finalizeModel` like every other format.
 *
 * All the Rhino interpretation — colour sources, blocks, units, the frame
 * restore, user text, class validation, identity — is behind `RhinoImport`.
 * This module therefore has no branch on a Rhino geometry type: one would
 * mean the reader's result is missing something, and the fix belongs there
 * (docs/architecture/rhino-3dm-import.md, "Architecture").
 */

import {
  EntityTableBuilder,
  PropertyTableBuilder,
  PropertyValueType,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
  RelationshipType,
  StringTable,
} from '@ifc-lite/data';
import { countCopy } from '@ifc-lite/load-trace';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData, PointCloudAsset } from '@ifc-lite/geometry';
import type { RhinoImport, RhinoImportPropertySet } from '@ifc-lite/rhino3dm';

import { RhinoImportError, readRhino3dmInWorker, rhino3dmSizeRefusal } from '@/lib/import/rhino-import-client';
import { calculateMeshBounds, createCoordinateInfo, expandBoundsForPointClouds } from '../../utils/localParsingUtils.js';
import { sourceArrayBuffer } from './sourceBuffers.js';
import { rebuildSpatialHierarchy } from '../../utils/spatialHierarchy.js';
import { applyStatedStoreyElevations } from '../../utils/statedStoreyElevations.js';
import { planRhinoTree, type RhinoTreePlan } from './rhinoLayerTree.js';
import { buildTabularDataStore, type TabularStoreTables } from './tabularDataStore.js';
import type { ViewerModelPayload } from './viewerModelIngest.js';

/**
 * Express ids run from 1 in entity order, so `getMaxExpressId` and the
 * federation offset work unchanged. `IFC::ExpressId` stays a property: it is
 * unique only in the IFC the `.3dm` came from.
 */
const expressIdOf = (entityIndex: number): number => entityIndex + 1;

/**
 * The `UnitSystem` members rhino3dm exposes no scale for, which the reader
 * reads as metres with a warning (`packages/rhino3dm/src/read/document.ts`).
 * For those the store's metre scale is the format's assumption, not the file's
 * statement.
 */
const UNSCALED_UNIT_SYSTEMS = new Set(['None', 'CustomUnits', 'Unset']);

/** Entity indices the viewer has geometry for in this payload. */
function drawnEntities(result: RhinoImport): Set<number> {
  const drawn = new Set<number>();
  for (const mesh of result.meshes) drawn.add(mesh.entity);
  for (const cloud of result.pointClouds) drawn.add(cloud.entity);
  return drawn;
}

/**
 * What the file says about itself, on the tree's root entity, so the model
 * metadata panel shows it where it shows an IfcProject's own data (the spec's
 * "Document strings and document user text go to the model metadata panel").
 *
 * The document's user text is listed under the key each entry is written
 * with, unparsed: the reader's `<Set>::<Prop>` sorting rule is for an
 * object's Attribute User Text, and restating it here would be a second copy
 * of it.
 */
function documentPropertySets(result: RhinoImport): RhinoImportPropertySet[] {
  const { document } = result;
  const facts: [string, string][] = [];
  if (document.application) facts.push(['Application', document.application]);
  facts.push(['Provenance', document.provenance]);
  facts.push(['Unit system', document.unitSystem]);
  facts.push(['Metres per unit', String(document.metersPerUnit)]);
  facts.push(['Archive version', String(document.archiveVersion)]);
  facts.push(['Coordinate frame', document.frame]);
  facts.push(['Layers', String(result.layers.length)]);
  if (document.earthAnchor) {
    facts.push(['Earth anchor latitude', String(document.earthAnchor.latitude)]);
    facts.push(['Earth anchor longitude', String(document.earthAnchor.longitude)]);
    facts.push(['Earth anchor elevation', String(document.earthAnchor.elevation)]);
  }
  const skipped = skippedSummary(result);
  if (skipped) facts.push(['Not drawn', skipped]);
  const sets: RhinoImportPropertySet[] = [{ name: 'Rhino Document', properties: facts }];
  if (document.strings.length > 0) sets.push({ name: 'Document User Text', properties: [...document.strings] });
  return sets;
}

/** What the reader could not draw, in one line, or '' when it drew everything. */
function skippedSummary(result: RhinoImport): string {
  return Object.entries(result.skipped).map(([reason, count]) => `${count} ${reason}`).join(', ');
}

/** The elevations the layer stamps state, by the express id of their node. */
function statedElevations(tree: RhinoTreePlan): Map<number, number> {
  const stated = new Map<number, number>();
  for (const container of tree.containers) {
    if (container.elevation !== null) stated.set(container.expressId, container.elevation);
  }
  return stated;
}

/** The string, entity, property and relationship tables for one `.3dm`. */
function buildRhinoTables(result: RhinoImport, tree: RhinoTreePlan): TabularStoreTables {
  const strings = new StringTable();
  const entities = new EntityTableBuilder(result.entities.length + tree.containers.length, strings);
  const properties = new PropertyTableBuilder(strings);
  const relationships = new RelationshipGraphBuilder();
  const drawn = drawnEntities(result);
  const addProperties = (expressId: number, sets: readonly RhinoImportPropertySet[]) => {
    for (const set of sets) {
      for (const [propName, value] of set.properties) {
        // Attribute User Text is string-only, so every value is an IfcLabel.
        // The reader does the sorting into sets; nothing is guessed here.
        properties.add({
          entityId: expressId, psetName: set.name, psetGlobalId: '',
          propName, propType: PropertyValueType.Label, value,
        });
      }
    }
  };

  result.entities.forEach((entity, index) => {
    const expressId = expressIdOf(index);
    entities.add(
      expressId, entity.ifcClass, entity.globalId, entity.name,
      entity.description, entity.objectType, drawn.has(index),
    );
    addProperties(expressId, entity.propertySets);
  });
  // Containers come after the entities, so express ids stay ascending. One the
  // file already holds as an object has its row above (`fromEntity`).
  for (const container of tree.containers) {
    if (container.fromEntity) continue;
    entities.add(container.expressId, container.ifcClass, container.globalId, container.name, '', '', false);
  }
  addProperties(tree.root, documentPropertySets(result));

  // Spatial edges, as IFC states them: a container decomposes its parent
  // (IfcRelAggregates), an object is contained in its container
  // (IfcRelContainedInSpatialStructure). `relationshipId` is synthetic, as
  // IFCX's is, and continues past the containers so it cannot be read as one
  // of this store's entities.
  let relationshipId = tree.firstFreeExpressId;
  for (const container of tree.containers) {
    if (container.parent !== null) {
      relationships.addEdge(container.parent, container.expressId, RelationshipType.Aggregates, relationshipId++);
    }
  }
  tree.containerOfEntity.forEach((containerId, index) => {
    // A null container is an object that IS a container: its parent aggregates
    // it, above, so a containment edge would place it inside itself.
    if (containerId === null) return;
    relationships.addEdge(containerId, expressIdOf(index), RelationshipType.ContainsElements, relationshipId++);
  });

  const entityTable = entities.build();
  const relationshipGraph = relationships.build();
  // The shared builder, off the two tables above: `buildFromCache` is the
  // source-less path the viewer already rebuilds a cached IFC model's
  // hierarchy with, so a `.3dm` tree cannot drift from the IFC one. It reads
  // elevations from STEP bytes this store has none of, hence the second step.
  const spatialHierarchy = rebuildSpatialHierarchy(entityTable, relationshipGraph);
  if (spatialHierarchy) applyStatedStoreyElevations(spatialHierarchy, statedElevations(tree));

  return {
    strings,
    entities: entityTable,
    properties: properties.build(),
    // A .3dm carries no quantities; the table is empty rather than absent,
    // because the store's accessors read it.
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: relationshipGraph,
    spatialHierarchy,
  };
}

/** The populated store for one `.3dm`. */
function buildRhinoDataStore(result: RhinoImport, tree: RhinoTreePlan, buffer: ArrayBuffer, parseTime: number): IfcDataStore {
  return buildTabularDataStore(buildRhinoTables(result, tree), {
    // The schema the entity table's type names belong to, which is all this
    // says: what backs the store is `sourceKind: 'tabular'`, set by
    // `buildTabularDataStore`. See the spec's "What the store says about
    // itself" for why IFC4 and not IFC5.
    schemaVersion: 'IFC4',
    source: buffer,
    fileSize: buffer.byteLength,
    parseTime,
    // The reader scaled every coordinate to metres, so the store's own scale
    // is 1 whatever the file's unit system was.
    lengthUnitScale: 1,
    lengthUnitSource: UNSCALED_UNIT_SYSTEMS.has(result.document.unitSystem) ? 'default' : 'declared',
  });
}

/**
 * `MeshData` keeps the reader's double-precision `origin` and f32 offsets as
 * they are: world position of vertex i is `origin + positions[3i..3i+3]`, the
 * same contract the wasm pipeline's per-element frame uses. Nothing is
 * rewritten per vertex on the main thread.
 */
function convertRhinoMeshes(result: RhinoImport): MeshData[] {
  return result.meshes.map((mesh) => ({
    expressId: expressIdOf(mesh.entity),
    ifcType: result.entities[mesh.entity].ifcClass,
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    origin: mesh.origin,
    color: mesh.color,
  }));
}

/**
 * Point clouds ride the payload's `pointClouds`, as IFCX's do (decision D6).
 *
 * The reader's double origin and f32 offsets map straight onto
 * `PointCloudAsset.origin` and `chunk.positions`, the same contract `MeshData`
 * has, so a cloud far from the origin keeps its millimetres (#10029). Only the
 * colours change: the renderer takes 0..1 floats per point.
 */
function convertRhinoPointClouds(result: RhinoImport): PointCloudAsset[] {
  return result.pointClouds.map((cloud) => {
    const pointCount = Math.floor(cloud.positions.length / 3);
    const bytes = cloud.colors;
    // A cloud with no per-point colours still has the colour its object or
    // layer gives it, and the renderer's only channel for that is per point.
    const colors = new Float32Array(pointCount * 3);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let point = 0; point < pointCount; point++) {
      const at = point * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = cloud.positions[at + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
        colors[at + axis] = bytes ? bytes[point * 4 + axis] / 255 : cloud.color[axis];
      }
    }
    return {
      expressId: expressIdOf(cloud.entity),
      ifcType: result.entities[cloud.entity].ifcClass,
      origin: cloud.origin,
      chunk: { positions: cloud.positions, colors, pointCount, bbox: { min, max } },
    };
  });
}

/**
 * What the reader reported and what this payload leaves undrawn, in one line
 * each. The console is where `dxfIngest` puts the same kind of note, but it is
 * the weaker of the two precedents: `loadReport.ts` already renders
 * `{count, reason}` rows for "these elements are missing from the 3D view",
 * which is exactly the shape of `skipped`. Routing it there is still open; the
 * counts do reach the model metadata panel, on the tree's root entity.
 */
function reportRhinoImport(result: RhinoImport): void {
  for (const warning of result.warnings) console.warn(`[rhino3dm] ${warning}`);
  const skipped = skippedSummary(result);
  if (skipped) console.warn(`[rhino3dm] not drawn: ${skipped}`);
  // Curves and text dots need a line and a label primitive for federated
  // models, which is viewer work this change does not do (decision D6).
  if (result.curves.length > 0 || result.textDots.length > 0) {
    console.warn(`[rhino3dm] ${result.curves.length} curves and ${result.textDots.length} text dots are in the file but not yet drawn`);
  }
}

/**
 * What Rhino hides: an object's own flag or a layer off (the reader folds the
 * layer path into `hidden`), and the layer row itself, so a layer that is off
 * reads as off in the tree and one click shows it again.
 */
function hiddenOf(result: RhinoImport, tree: RhinoTreePlan): number[] {
  const hidden: number[] = [];
  result.entities.forEach((entity, index) => { if (entity.hidden) hidden.push(expressIdOf(index)); });
  for (const container of tree.containers) if (container.hidden) hidden.push(container.expressId);
  return hidden;
}

/**
 * Build the viewer payload for a result the worker has already axis-swapped.
 *
 * `fileName` labels the tree's root when the file carries no spatial stamps:
 * the root stands for the file, which states no project name of its own.
 */
export function rhinoViewerModel(result: RhinoImport, buffer: ArrayBuffer, parseTime: number, fileName: string): ViewerModelPayload {
  reportRhinoImport(result);
  const meshes = convertRhinoMeshes(result);
  const pointClouds = convertRhinoPointClouds(result);
  if (meshes.length === 0 && pointClouds.length === 0) {
    // The reader refuses a file it drew nothing from, so reaching here means it
    // drew only curves or text dots, which this viewer cannot show yet.
    throw new RhinoImportError(
      'no-renderable-geometry',
      'This Rhino file holds only curves, text dots or points. The viewer does not draw those yet; add surfaces, meshes or point clouds to see it.',
    );
  }

  const { bounds, stats } = calculateMeshBounds(meshes);
  expandBoundsForPointClouds(bounds, pointClouds);
  const tree = planRhinoTree(result, expressIdOf, fileName);

  return {
    dataStore: buildRhinoDataStore(result, tree, buffer, parseTime),
    geometryResult: {
      meshes,
      ...(pointClouds.length > 0 ? { pointClouds } : {}),
      totalVertices: stats.totalVertices,
      totalTriangles: stats.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds),
    },
    schemaVersion: 'IFC4',
    hiddenExpressIds: hiddenOf(result, tree),
  };
}

/**
 * Read a `.3dm` in the import worker and adapt it for `finalizeModel`.
 *
 * The request transfers its bytes, so it gets a copy of the load's own source
 * buffer rather than the buffer itself, which stays the store's `source`
 * (unshared first when the load streamed it into a `SharedArrayBuffer`). A
 * copy, not a second read of the `File`: re-reading would let a file saved
 * again mid-load put different bytes behind the geometry and the store.
 *
 * The size ceiling is asked before any copy, including the unsharing of a
 * streamed `SharedArrayBuffer`, so an archive over it is refused once rather
 * than duplicated first; `rhino3dmSizeRefusal` says why.
 */
export async function prepareRhinoViewerModel(
  loaded: ArrayBuffer | SharedArrayBuffer,
  fileName: string,
  onProgress?: (progress: { phase: string; percent: number }) => void,
  signal?: AbortSignal,
): Promise<ViewerModelPayload> {
  const started = performance.now();
  // A load already cancelled when it gets here is a cancellation, never a
  // refusal, and skips the copies below. The error is the worker client's own,
  // which is what the loader recognises as a cancel.
  if (signal?.aborted) throw new DOMException('Rhino import cancelled', 'AbortError');
  const refusal = rhino3dmSizeRefusal(loaded.byteLength);
  if (refusal) throw refusal;
  const buffer = sourceArrayBuffer(loaded, 'source.arrayBuffer');
  const bytes = new Uint8Array(countCopy('source.rhinoImport', buffer.slice(0)));
  const result = await readRhino3dmInWorker(bytes, ({ done, total }) => {
    onProgress?.({ phase: 'Reading Rhino .3dm', percent: 10 + (total > 0 ? (done / total) * 80 : 0) });
  }, signal);
  return rhinoViewerModel(result, buffer, performance.now() - started, fileName);
}
