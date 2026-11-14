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
  StringTable,
} from '@ifc-lite/data';
import { countCopy } from '@ifc-lite/load-trace';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData, PointCloudAsset } from '@ifc-lite/geometry';
import type { RhinoImport } from '@ifc-lite/rhino3dm';

import { RhinoImportError, readRhino3dmInWorker, rhino3dmSizeRefusal } from '@/lib/import/rhino-import-client';
import { calculateMeshBounds, createCoordinateInfo, expandBoundsForPointClouds } from '../../utils/localParsingUtils.js';
import { sourceArrayBuffer } from './sourceBuffers.js';
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

/** The string, entity and property tables for one `.3dm`. */
function buildRhinoTables(result: RhinoImport): TabularStoreTables {
  const strings = new StringTable();
  const entities = new EntityTableBuilder(Math.max(result.entities.length, 1), strings);
  const properties = new PropertyTableBuilder(strings);
  const drawn = drawnEntities(result);

  result.entities.forEach((entity, index) => {
    const expressId = expressIdOf(index);
    entities.add(
      expressId, entity.ifcClass, entity.globalId, entity.name,
      entity.description, entity.objectType, drawn.has(index),
    );
    for (const set of entity.propertySets) {
      for (const [propName, value] of set.properties) {
        // Attribute User Text is string-only, so every value is an IfcLabel.
        // The reader does the sorting into sets; nothing is guessed here.
        properties.add({
          entityId: expressId, psetName: set.name, psetGlobalId: '',
          propName, propType: PropertyValueType.Label, value,
        });
      }
    }
  });

  return {
    strings,
    entities: entities.build(),
    properties: properties.build(),
    // A .3dm carries no quantities, and the layer or spatial tree is its own
    // change (decision D3): both tables are empty rather than absent, because
    // the store's accessors read them.
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: new RelationshipGraphBuilder().build(),
  };
}

/** The populated store for one `.3dm`. */
function buildRhinoDataStore(result: RhinoImport, buffer: ArrayBuffer, parseTime: number): IfcDataStore {
  return buildTabularDataStore(buildRhinoTables(result), {
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
 * which is exactly the shape of `skipped`. Routing it there is the model
 * metadata work, not this change.
 */
function reportRhinoImport(result: RhinoImport): void {
  for (const warning of result.warnings) console.warn(`[rhino3dm] ${warning}`);
  const skipped = Object.entries(result.skipped);
  if (skipped.length > 0) {
    console.warn(`[rhino3dm] not drawn: ${skipped.map(([reason, count]) => `${count} ${reason}`).join(', ')}`);
  }
  // Curves and text dots need a line and a label primitive for federated
  // models, which is viewer work this change does not do (decision D6).
  if (result.curves.length > 0 || result.textDots.length > 0) {
    console.warn(`[rhino3dm] ${result.curves.length} curves and ${result.textDots.length} text dots are in the file but not yet drawn`);
  }
}

/** Build the viewer payload for a result the worker has already axis-swapped. */
export function rhinoViewerModel(result: RhinoImport, buffer: ArrayBuffer, parseTime: number): ViewerModelPayload {
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

  return {
    dataStore: buildRhinoDataStore(result, buffer, parseTime),
    geometryResult: {
      meshes,
      ...(pointClouds.length > 0 ? { pointClouds } : {}),
      totalVertices: stats.totalVertices,
      totalTriangles: stats.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds),
    },
    schemaVersion: 'IFC4',
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
  return rhinoViewerModel(result, buffer, performance.now() - started);
}
