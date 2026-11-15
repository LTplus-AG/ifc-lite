/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One site-context category (terrain, parcel, later buildings) as a viewer
 * model: a populated tabular data store, `MeshData[]` in the viewer's Y-up
 * frame, and the format-neutral spatial reference federation places it by.
 *
 * Frame. The document states a local site frame: origin `[E0, N0, H0]` in
 * EPSG:2056 / EPSG:5728, identity axes, scale 1. That is exactly a
 * `LocalProjectedOperation` with `xAxisAbscissa = 1`, so federation places the
 * category against the anchor model through `resolveSpatialPlacement` (same
 * CRS) or the cross-CRS point map, like any other georeferenced model. Each
 * feature keeps its own f64 origin: `MeshData.origin` is the feature origin
 * minus the document origin, in viewer axes, and the float32 positions are
 * the feature's own offsets, swapped from (east, north, up) to
 * (east, up, south). Nothing is rebased per vertex in f64 here.
 *
 * Semantics. One entity per feature, typed as the core says (`IfcSite` for a
 * parcel, `IfcGeographicElement` for terrain), under an `IfcProject` root so
 * the hierarchy panel shows the category like any model. Nested attribute
 * objects become property sets under their own name (the parcel's
 * `Pset_LandRegistration`); scalar attributes go to `IfcLite_SiteContext`
 * and provenance to `IfcLite_SiteContextProvenance`.
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
import { uuidFromSeed, uuidToIfcGuid } from '@ifc-lite/encoding';
import type { MeshData, ModelSpatialReference } from '@ifc-lite/geometry';
import type { JsonValue, SiteContextDocument, SiteContextFeature, SiteContextLayer, SiteContextLayerKind } from '@ifc-lite/site-context';
import type { ViewerModelPayload } from '@/hooks/ingest/viewerModelIngest';
import { buildTabularDataStore } from '@/hooks/ingest/tabularDataStore';
import { calculateMeshBounds, createCoordinateInfo } from '@/utils/localParsingUtils';
import { rebuildSpatialHierarchy } from '@/utils/spatialHierarchy';
import { parcelCasing, parcelDisplayWidth, widenParcelRibbon } from './parcel-outline';

/** The property set scalar attributes go to; the IFC prefix `Pset_` is reserved for buildingSMART sets. */
export const SITE_CONTEXT_PSET = 'IfcLite_SiteContext';
export const SITE_CONTEXT_PROVENANCE_PSET = 'IfcLite_SiteContextProvenance';

/**
 * Neighbouring-building massing tones: the one place to tune them. Neutral and
 * light, so the context reads as massing and the user's model (often white
 * walls, a coloured roof) stays the subject; roofs a clearly darker grey so
 * roof and wall planes separate at a glance from the air. Both nearly
 * desaturated (a trace of warmth, never pink or brown) so they sit calmly on
 * the aerial imagery. The wall is held below white so a sunlit face keeps its
 * form under the renderer's sun (checked at 21 June 17:30 and midday, in the
 * light and dark themes).
 */
export const NEIGHBOUR_TONES = {
  wall: [0.74, 0.74, 0.73, 1],
  roof: [0.56, 0.56, 0.55, 1],
} as const satisfies Record<'wall' | 'roof', readonly [number, number, number, number]>;

/**
 * Viewer colours. Neutral and light enough that the renderer's sun shading
 * carries the relief; the skirt is darker so the cut edge reads as earth, not
 * as a wall competing with the model. The parcel boundary is a saturated
 * orange that stays legible over grass, asphalt and the aerial image.
 */
const COLOURS = {
  terrain: [0.80, 0.78, 0.72, 1],
  skirt: [0.47, 0.44, 0.40, 1],
  parcel: [1.0, 0.36, 0.05, 1],
  parcelCasing: [0.10, 0.08, 0.07, 1],
  buildings: NEIGHBOUR_TONES.wall,
  buildingRoof: NEIGHBOUR_TONES.roof,
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** The model name a category shows in the hierarchy. */
export function siteContextModelName(kind: SiteContextLayerKind): string {
  return `Site context · ${kind[0].toUpperCase()}${kind.slice(1)}`;
}

/** The spatial reference the document's frame states: EPSG:2056 + LN02, identity axes, scale 1. */
export function siteContextSpatialReference(doc: Pick<SiteContextDocument, 'crs' | 'verticalCrs' | 'origin'>, kind: SiteContextLayerKind): ModelSpatialReference {
  const [e0, n0, h0] = doc.origin;
  return Object.freeze({
    source: Object.freeze({ axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 } as const),
    horizontal: Object.freeze({ id: doc.crs, provenance: Object.freeze({ source: 'site-context document' }) }),
    vertical: Object.freeze({ id: doc.verticalCrs, provenance: Object.freeze({ source: 'site-context document' }) }),
    localToProjected: Object.freeze({
      kind: 'local-projected-affine', eastings: e0, northings: n0, orthogonalHeight: h0,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
    } as const),
    confidence: 'declared',
    sourceMetadata: Object.freeze({ format: 'site-context', category: kind }),
  });
}

/** True for a feature mesh the core marks as the terrain skirt. */
function isSkirt(feature: SiteContextFeature): boolean {
  return feature.id === 'terrain:skirt';
}

function colourOf(kind: SiteContextLayerKind, feature: SiteContextFeature): [number, number, number, number] {
  const colour = kind === 'terrain' && isSkirt(feature) ? COLOURS.skirt : COLOURS[kind];
  return [colour[0], colour[1], colour[2], colour[3]];
}

/** Site frame (east, north, up) → viewer (east, up, south). Exact: only a swap and a negation. */
function toViewerAxes(source: Float32Array): Float32Array {
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    out[i] = source[i];
    out[i + 1] = source[i + 2];
    out[i + 2] = -source[i + 1];
  }
  return out;
}

const expressIdOf = (featureIndex: number): number => featureIndex + 1;

/** Options for how a category is drawn (not what it is). */
export interface SiteContextDrawOptions {
  /** Drawn parcel line width in metres; defaults to the width for a 300 m site. */
  parcelWidth?: number;
}

/** Feature meshes in viewer axes, each with its f64 origin relative to the document origin. */
export function siteContextMeshes(doc: Pick<SiteContextDocument, 'origin'>, layer: SiteContextLayer, draw: SiteContextDrawOptions = {}): MeshData[] {
  const [e0, n0, h0] = doc.origin;
  const parcelWidth = draw.parcelWidth ?? parcelDisplayWidth(300);
  const meshes: MeshData[] = [];
  layer.features.forEach((feature, index) => {
    if (!feature.mesh || feature.mesh.indices.length === 0) return;
    const [e, n, h] = feature.origin;
    const origin: [number, number, number] = [e - e0, h - h0, -(n - n0)];
    const isParcel = layer.kind === 'parcel';
    const parts = feature.mesh.parts;
    if (parts && parts.length > 0) {
      // One renderer mesh per part (roof, wall), each with its own colour; the
      // vertex arrays are shared and the entity is the same, so the building
      // still selects, hides and sections as one.
      const positions = toViewerAxes(feature.mesh.positions);
      const normals = toViewerAxes(feature.mesh.normals);
      for (const part of parts) {
        if (part.indexCount <= 0) continue;
        const c = part.name === 'roof' ? COLOURS.buildingRoof : COLOURS[layer.kind];
        meshes.push({
          expressId: expressIdOf(index), ifcType: feature.ifcType, positions, normals,
          indices: feature.mesh.indices.slice(part.firstIndex, part.firstIndex + part.indexCount),
          origin, color: [c[0], c[1], c[2], c[3]],
        });
      }
      return;
    }
    meshes.push({
      expressId: expressIdOf(index),
      ifcType: feature.ifcType,
      positions: toViewerAxes(isParcel ? widenParcelRibbon(feature.mesh.positions, parcelWidth) : feature.mesh.positions),
      normals: toViewerAxes(feature.mesh.normals),
      indices: feature.mesh.indices,
      origin,
      color: colourOf(layer.kind, feature),
      // The core's terrain UVs (u east, v south over the terrain box). The
      // renderer textures only a mesh with UVs AND an image, so they wait
      // here, untouched by alignment, for the aerial drape.
      ...(feature.mesh.uvs && !isSkirt(feature) ? { uvs: feature.mesh.uvs } : {}),
    });
    if (isParcel) {
      // The dark casing: a second mesh of the same entity, so it selects,
      // hides and sections with the line.
      const casing = parcelCasing(feature.mesh.positions, feature.mesh.indices, parcelWidth);
      const c = COLOURS.parcelCasing;
      meshes.push({
        expressId: expressIdOf(index), ifcType: feature.ifcType,
        positions: toViewerAxes(casing.positions), normals: toViewerAxes(casing.normals), indices: casing.indices,
        origin, color: [c[0], c[1], c[2], c[3]],
      });
    }
  });
  return meshes;
}

/**
 * The terrain's plan box `[minE, minN, maxE, maxN]` in EPSG:2056: the box the
 * core's UVs span (u = 0 at minE, v = 0 at maxN). `null` without UV features.
 */
export function terrainPlanBox(layer: SiteContextLayer): [number, number, number, number] | null {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const feature of layer.features) {
    if (!feature.mesh?.uvs) continue;
    const [e, n] = feature.origin;
    const p = feature.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = e + p[i], y = n + p[i + 1];
      if (x < minE) minE = x;
      if (x > maxE) maxE = x;
      if (y < minN) minN = y;
      if (y > maxN) maxN = y;
    }
  }
  return minE < maxE && minN < maxN ? [minE, minN, maxE, maxN] : null;
}

function propertyType(value: JsonValue): { type: PropertyValueType; value: string | number | boolean } {
  if (typeof value === 'number') return { type: PropertyValueType.Real, value };
  if (typeof value === 'boolean') return { type: PropertyValueType.Boolean, value };
  if (typeof value === 'string') return { type: PropertyValueType.Label, value };
  return { type: PropertyValueType.Text, value: JSON.stringify(value) };
}

type PropertySink = (expressId: number, pset: string, name: string, value: JsonValue) => void;

function addAttributes(expressId: number, attributes: SiteContextFeature['attributes'], add: PropertySink): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      // A nested object is a property set the core laid out for a writer (Pset_LandRegistration).
      for (const [prop, inner] of Object.entries(value)) if (inner !== null) add(expressId, key, prop, inner);
    } else {
      add(expressId, SITE_CONTEXT_PSET, key, value);
    }
  }
}

/** Entities, properties and the IfcProject root for one category. */
function buildTables(layer: SiteContextLayer, modelName: string) {
  const strings = new StringTable();
  const featureCount = layer.features.length;
  const rootId = featureCount + 1;
  // Terrain chunks are geographic elements; IFC places those in a site. The
  // parcel is itself an IfcSite and is aggregated by the project directly.
  const containerId = layer.kind === 'parcel' ? null : featureCount + 2;
  const entities = new EntityTableBuilder(featureCount + 2, strings);
  const properties = new PropertyTableBuilder(strings);
  const relationships = new RelationshipGraphBuilder();
  const add: PropertySink = (entityId, psetName, propName, raw) => {
    const { type, value } = propertyType(raw);
    properties.add({ entityId, psetName, psetGlobalId: '', propName, propType: type, value });
  };

  layer.features.forEach((feature, index) => {
    const expressId = expressIdOf(index);
    const hasGeometry = feature.mesh !== null && feature.mesh.indices.length > 0;
    entities.add(expressId, feature.ifcType, uuidToIfcGuid(uuidFromSeed(`site-context:${feature.id}`)), feature.name, '', '', hasGeometry);
    add(expressId, SITE_CONTEXT_PSET, 'Id', feature.id);
    addAttributes(expressId, feature.attributes, add);
    for (const [key, value] of Object.entries(feature.provenance)) {
      if (value !== null) add(expressId, SITE_CONTEXT_PROVENANCE_PSET, key, value);
    }
  });
  entities.add(rootId, 'IfcProject', uuidToIfcGuid(uuidFromSeed(`site-context:project:${layer.kind}`)), modelName, '', '', false);
  if (containerId !== null) {
    entities.add(containerId, 'IfcSite', uuidToIfcGuid(uuidFromSeed(`site-context:site:${layer.kind}`)), modelName, '', '', false);
  }
  // Attribution and completeness on the root, where the metadata panel reads a project's own data.
  add(rootId, SITE_CONTEXT_PSET, 'Category', layer.kind);
  add(rootId, SITE_CONTEXT_PSET, 'Complete', layer.complete);
  add(rootId, SITE_CONTEXT_PSET, 'Attribution', layer.attribution.map((a) => a.text).join('; '));

  let relationshipId = rootId + 2;
  if (containerId !== null) {
    relationships.addEdge(rootId, containerId, RelationshipType.Aggregates, relationshipId++);
    layer.features.forEach((_, index) => {
      relationships.addEdge(containerId, expressIdOf(index), RelationshipType.ContainsElements, relationshipId++);
    });
  } else {
    layer.features.forEach((_, index) => {
      relationships.addEdge(rootId, expressIdOf(index), RelationshipType.Aggregates, relationshipId++);
    });
  }
  const entityTable = entities.build();
  const relationshipGraph = relationships.build();
  return {
    strings,
    entities: entityTable,
    properties: properties.build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: relationshipGraph,
    spatialHierarchy: rebuildSpatialHierarchy(entityTable, relationshipGraph),
  };
}

export interface SiteContextModelPayload extends ViewerModelPayload {
  spatialReference: ModelSpatialReference;
}

/**
 * The viewer payload for one category of a decoded document. `source` is the
 * category's own GLB bytes, kept as the store's `source` like every format.
 */
export function siteContextViewerModel(
  doc: Pick<SiteContextDocument, 'crs' | 'verticalCrs' | 'origin'>,
  layer: SiteContextLayer,
  source: ArrayBuffer,
  parseTime: number,
  draw: SiteContextDrawOptions = {},
): SiteContextModelPayload {
  const meshes = siteContextMeshes(doc, layer, draw);
  const { bounds, stats } = calculateMeshBounds(meshes);
  const modelName = siteContextModelName(layer.kind);
  const dataStore = buildTabularDataStore(buildTables(layer, modelName), {
    schemaVersion: 'IFC4',
    source,
    fileSize: source.byteLength,
    parseTime,
    lengthUnitScale: 1,
    lengthUnitSource: 'declared',
  });
  return {
    dataStore,
    geometryResult: {
      meshes,
      totalVertices: stats.totalVertices,
      totalTriangles: stats.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds),
    },
    schemaVersion: 'IFC4',
    spatialReference: siteContextSpatialReference(doc, layer.kind),
  };
}
