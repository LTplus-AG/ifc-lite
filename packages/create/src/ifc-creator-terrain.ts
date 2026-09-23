/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Survey/terrain emitters for `IfcCreator` — the IFC4X3 entities the
 * LandXML→IFC v1 mapping needs and no building element does.
 *
 * Split out of `ifc-creator.ts` the same way `ifc-creator-definitions.ts` and
 * `ifc-creator-scheduling.ts` are: the creator keeps the spatial spine, the id
 * allocator and the STEP writer, and hands this module the one `emit` hook.
 *
 * Coordinate contract, and it is the whole reason this file is reviewed
 * carefully: every `Coordinates`/`Location` triple here is
 * **(X, Y, Z) = (easting, northing, elevation)**, already in the file's length
 * unit. LandXML's own `<P>`/`<CgPoint>` text order is *northing easting
 * elevation*; transposing it is silent — a transpose is a reflection, so the
 * mesh is still well-formed and every count assertion still passes. Callers
 * convert; this module never reorders, and never guesses from magnitude.
 *
 * See `docs/architecture/landxml-to-ifc-mapping.md` §2.2 and §4.1.
 */

import { esc, num } from './ifc-creator-math.js';

/** The creator hooks these emitters need. */
export interface TerrainContext {
  /** Allocate an express id, write its STEP line, return the id. */
  emit: (type: string, attrs: string) => number;
  newGlobalId: () => string;
  /** `#<id>` of the shared `IfcOwnerHistory`. */
  ownerRef: string;
  /** `#<id>` of the `IfcGeometricRepresentationContext` ('Model'). */
  modelContextRef: string;
  /** `#<id>` of the 'Body' subcontext. */
  bodyContextRef: string;
  /** `#<id>` of the placement products of the site hang from. */
  sitePlacementRef: string;
  /** Reject anything this schema cannot express. */
  assertSchema: (feature: string) => void;
}

/** A single terrain surface: a TIN and the element that carries it. */
export interface TerrainSurfaceParams {
  Name: string;
  Description?: string | null;
  /** Supply to make the GlobalId a function of the source id (§4.3). */
  GlobalId?: string;
  /** `(easting, northing, elevation)` per vertex, in the file's length unit. */
  Coordinates: ReadonlyArray<readonly [number, number, number]>;
  /** **1-based** triples indexing `Coordinates`, per `IfcTriangulatedFaceSet`. */
  Triangles: ReadonlyArray<readonly [number, number, number]>;
  /**
   * `IfcTriangulatedIrregularNetwork.Flags` — mandatory and non-empty, unlike
   * most IFC list attributes. Defaults to a single `0` (no flag set).
   */
  Flags?: readonly number[];
}

export interface TerrainSurfaceResult {
  elementId: number;
  /** The `IfcTriangulatedIrregularNetwork`, so a caller can assert on it directly. */
  tinId: number;
  coordinateListId: number;
}

/** One survey point, shaped like the IfcOpenShell control in §8.2 of the mapping. */
export interface SurveyPointParams {
  Name?: string | null;
  Description?: string | null;
  GlobalId?: string;
  /** `(easting, northing, elevation)` in the file's length unit. */
  Location: readonly [number, number, number];
}

/** A `Pset`-style bag attached to one product. Values are written as IFCLABEL. */
export interface SurveyPropertySetParams {
  Name: string;
  GlobalId?: string;
  Properties: ReadonlyArray<{ Name: string; Value: string }>;
}

export interface GeoreferencingParams {
  /** `IfcProjectedCRS.Name` — required in practice by the `NameOrWKT` rule. */
  Name: string;
  Description?: string | null;
  GeodeticDatum?: string | null;
  VerticalDatum?: string | null;
  MapProjection?: string | null;
  MapZone?: string | null;
  /** `#<id>` of a length `IfcNamedUnit`, or omit for `$`. */
  MapUnitRef?: string;
  Eastings?: number;
  Northings?: number;
  OrthogonalHeight?: number;
  XAxisAbscissa?: number;
  XAxisOrdinate?: number;
  Scale?: number;
}

function assertFiniteTriple(triple: readonly number[], what: string): void {
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(triple[axis])) {
      throw new Error(`${what}: coordinate ${axis} is ${String(triple[axis])} — every coordinate must be finite`);
    }
  }
}

function optText(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '$' : `'${esc(value)}'`;
}

/**
 * Write a terrain surface: `IfcCartesianPointList3D` → `IfcTriangulatedIrregularNetwork`
 * → `IfcShapeRepresentation` → `IfcGeographicElement`/`.TERRAIN.`.
 *
 * The `IfcTriangulatedIrregularNetwork` constraints in §4.1 are enforced here
 * rather than assumed, because both fail open in a STEP file: `Closed` omitted
 * as `$` does not satisfy `NotClosed : Closed = FALSE`, and an empty `Flags`
 * violates `LIST [1:?]`. Neither shows up as a parse error downstream.
 */
export function emitTerrainSurface(params: TerrainSurfaceParams, ctx: TerrainContext): TerrainSurfaceResult {
  ctx.assertSchema('addIfcTerrainSurface');
  const vertexCount = params.Coordinates.length;
  if (vertexCount === 0) {
    throw new Error('addIfcTerrainSurface: Coordinates is empty — IfcCartesianPointList3D.CoordList is LIST [1:?]');
  }
  if (params.Triangles.length === 0) {
    throw new Error('addIfcTerrainSurface: Triangles is empty — IfcTriangulatedFaceSet.CoordIndex is LIST [1:?]');
  }
  const flags = params.Flags ?? [0];
  if (flags.length === 0) {
    throw new Error('addIfcTerrainSurface: Flags is empty — IfcTriangulatedIrregularNetwork.Flags is LIST [1:?] and is not optional');
  }
  for (const flag of flags) {
    if (!Number.isInteger(flag)) {
      throw new Error(`addIfcTerrainSurface: Flags entry ${String(flag)} is not an integer — Flags is LIST OF IfcInteger`);
    }
  }

  params.Coordinates.forEach((point, index) => {
    assertFiniteTriple(point, `addIfcTerrainSurface: vertex ${index}`);
  });
  params.Triangles.forEach((triangle, index) => {
    for (const vertexIndex of triangle) {
      if (!Number.isInteger(vertexIndex) || vertexIndex < 1 || vertexIndex > vertexCount) {
        throw new Error(
          `addIfcTerrainSurface: triangle ${index} references vertex ${String(vertexIndex)}, `
          + `outside the 1-based range 1..${vertexCount} — CoordIndex is LIST OF IfcPositiveInteger`,
        );
      }
    }
  });

  const coordList = params.Coordinates
    .map(([x, y, z]) => `(${num(x)},${num(y)},${num(z)})`)
    .join(',');
  const coordinateListId = ctx.emit('IFCCARTESIANPOINTLIST3D', `(${coordList}),$`);

  const coordIndex = params.Triangles.map(([a, b, c]) => `(${a},${b},${c})`).join(',');
  // Attribute order in FINAL IFC4X3 (ISO 16739-1:2024): Coordinates, Closed,
  // Normals, CoordIndex, PnIndex, Flags — `Closed` moved up to
  // `IfcTessellatedFaceSet`. The repo's `packages/codegen/schemas/IFC4X3.exp`
  // is a pre-release DEV draft (`IFC4X3_DEV_923b0514`) that still lists
  // `Normals` first; writing that order put `.F.` into `Normals`, which
  // `ifcopenshell.validate` rejects. `ifcopenshell-conformance.test.ts` pins
  // this against the external schema, not ours.
  // `Closed` is written `.F.` explicitly — `$` fails the NotClosed rule.
  const tinId = ctx.emit(
    'IFCTRIANGULATEDIRREGULARNETWORK',
    `#${coordinateListId},.F.,$,(${coordIndex}),$,(${flags.join(',')})`,
  );

  const representationId = ctx.emit(
    'IFCSHAPEREPRESENTATION',
    `${ctx.bodyContextRef},'Body','Tessellation',(#${tinId})`,
  );
  const shapeId = ctx.emit('IFCPRODUCTDEFINITIONSHAPE', `$,$,(#${representationId})`);

  const globalId = params.GlobalId ?? ctx.newGlobalId();
  const elementId = ctx.emit(
    'IFCGEOGRAPHICELEMENT',
    `'${globalId}',${ctx.ownerRef},'${esc(params.Name)}',${optText(params.Description)},$,`
    + `${ctx.sitePlacementRef},#${shapeId},$,.TERRAIN.`,
  );

  return { elementId, tinId, coordinateListId };
}

/**
 * Write one survey point as `IfcAnnotation`/`.SURVEY.`.
 *
 * The position lives in the `IfcLocalPlacement`, and the representation is an
 * `IfcCartesianPoint` at the LOCAL origin — not a second copy of the
 * coordinate. That split is deliberate: it is the shape the IfcOpenShell
 * control in §8.2 writes, which is what makes our output comparable to
 * something produced outside this repo, and it keeps one authoritative
 * location per point instead of two that can disagree.
 */
export function emitSurveyPoint(params: SurveyPointParams, ctx: TerrainContext): number {
  ctx.assertSchema('addIfcSurveyPoint');
  assertFiniteTriple(params.Location, 'addIfcSurveyPoint');

  const localOriginId = ctx.emit('IFCCARTESIANPOINT', '(0.,0.,0.)');
  const representationId = ctx.emit(
    'IFCSHAPEREPRESENTATION',
    `${ctx.modelContextRef},'Point','Point',(#${localOriginId})`,
  );
  const shapeId = ctx.emit('IFCPRODUCTDEFINITIONSHAPE', `$,$,(#${representationId})`);

  const [easting, northing, elevation] = params.Location;
  const pointId = ctx.emit('IFCCARTESIANPOINT', `(${num(easting)},${num(northing)},${num(elevation)})`);
  const axisId = ctx.emit('IFCAXIS2PLACEMENT3D', `#${pointId},$,$`);
  const placementId = ctx.emit('IFCLOCALPLACEMENT', `${ctx.sitePlacementRef},#${axisId}`);

  const globalId = params.GlobalId ?? ctx.newGlobalId();
  return ctx.emit(
    'IFCANNOTATION',
    `'${globalId}',${ctx.ownerRef},${optText(params.Name)},${optText(params.Description)},$,`
    + `#${placementId},#${shapeId},.SURVEY.`,
  );
}

/**
 * Attach a property set to one product. Values are written as `IFCLABEL`
 * regardless of how numeric they look: a LandXML attribute is text, and
 * promoting `'00123'` to a number would lose a leading zero that identifies
 * the point.
 */
export function emitSurveyPropertySet(
  productId: number, params: SurveyPropertySetParams, ctx: TerrainContext,
): number {
  if (params.Properties.length === 0) {
    throw new Error('addIfcSurveyPropertySet: Properties is empty — IfcPropertySet.HasProperties is SET [1:?]');
  }
  const propertyIds = params.Properties.map(({ Name, Value }) => ctx.emit(
    'IFCPROPERTYSINGLEVALUE',
    `'${esc(Name)}',$,IFCLABEL('${esc(Value)}'),$`,
  ));
  const setId = ctx.emit(
    'IFCPROPERTYSET',
    `'${params.GlobalId ?? ctx.newGlobalId()}',${ctx.ownerRef},'${esc(params.Name)}',$,`
    + `(${propertyIds.map((id) => `#${id}`).join(',')})`,
  );
  ctx.emit(
    'IFCRELDEFINESBYPROPERTIES',
    `'${ctx.newGlobalId()}',${ctx.ownerRef},$,$,(#${productId}),#${setId}`,
  );
  return setId;
}

/**
 * Write `IfcProjectedCRS` + `IfcMapConversion`.
 *
 * `SourceCRS` is the model `IfcGeometricRepresentationContext` and `TargetCRS`
 * the projected CRS, which is what `TargetCRSOnlyProjected` requires. Callers
 * emit this only where the source actually declares a coordinate system —
 * §4.2 forbids a placeholder CRS, because a wrong CRS is worse than none.
 */
export function emitGeoreferencing(params: GeoreferencingParams, ctx: TerrainContext): { crsId: number; mapConversionId: number } {
  ctx.assertSchema('setGeoreferencing');
  if (params.Name === '') {
    throw new Error('setGeoreferencing: Name is empty — IfcCoordinateReferenceSystem.NameOrWKT requires a Name when there is no WellKnownText');
  }
  const crsId = ctx.emit(
    'IFCPROJECTEDCRS',
    `'${esc(params.Name)}',${optText(params.Description)},${optText(params.GeodeticDatum)},`
    + `${optText(params.VerticalDatum)},${optText(params.MapProjection)},${optText(params.MapZone)},`
    + `${params.MapUnitRef ?? '$'}`,
  );
  const optNum = (value: number | undefined): string => (value === undefined ? '$' : num(value));
  // FINAL IFC4X3 adds `ScaleY` and `ScaleZ` after `Scale` (10 attributes; the
  // DEV draft in `packages/codegen` has 8). Both are optional, and writing
  // them `$` keeps the single isotropic `Scale` meaning intact.
  const mapConversionId = ctx.emit(
    'IFCMAPCONVERSION',
    `${ctx.modelContextRef},#${crsId},${num(params.Eastings ?? 0)},${num(params.Northings ?? 0)},`
    + `${num(params.OrthogonalHeight ?? 0)},${optNum(params.XAxisAbscissa)},${optNum(params.XAxisOrdinate)},`
    + `${optNum(params.Scale)},$,$`,
  );
  return { crsId, mapConversionId };
}

/** The creator state a `TerrainWriter` mutates, kept behind functions. */
export interface TerrainWriterHost {
  /** Record a product as contained in the site and as a created entity. */
  trackSiteProduct: (expressId: number, type: string, name: string | undefined) => void;
  /** `#<id>` of the length unit `IfcProjectedCRS.MapUnit` defaults to. */
  lengthUnitRef: () => string;
  /** Throws if georeferencing was already declared for this file. */
  claimGeoreferencing: () => void;
  /** The `IfcSite` every terrain product is contained in. */
  siteId: () => number;
}

/**
 * Terrain/survey authoring, reached through `IfcCreator.terrain()`.
 *
 * Every product this writes is contained in the **site**, not a storey.
 * Terrain and survey points have no storey, and inventing one would place them
 * on a datum the LandXML source never declared — the storey's `Elevation` is
 * applied to its children, so a fabricated storey silently shifts every
 * coordinate.
 */
export interface TerrainWriter {
  /**
   * The `IfcSite` these products are contained in — the anchor for a
   * file-level property set such as the conversion's provenance.
   */
  readonly siteId: number;
  /**
   * Add one terrain surface: `IfcGeographicElement`/`.TERRAIN.` carrying an
   * `IfcTriangulatedIrregularNetwork`. `Coordinates` are
   * `(easting, northing, elevation)` in this file's length unit; `Triangles`
   * are 1-based.
   */
  addSurface(params: TerrainSurfaceParams): TerrainSurfaceResult;
  /** Add one survey point as `IfcAnnotation`/`.SURVEY.`. */
  addSurveyPoint(params: SurveyPointParams): number;
  /** Attach a text-valued property set to any product. */
  addPropertySet(productId: number, params: SurveyPropertySetParams): number;
  /**
   * Declare the projected CRS and the map conversion from it to this file's
   * engineering coordinates. At most once per file.
   */
  setGeoreferencing(params: GeoreferencingParams): { crsId: number; mapConversionId: number };
}

export function createTerrainWriter(ctx: TerrainContext, host: TerrainWriterHost): TerrainWriter {
  return {
    siteId: host.siteId(),
    addSurface(params) {
      const result = emitTerrainSurface(params, ctx);
      host.trackSiteProduct(result.elementId, 'IfcGeographicElement', params.Name);
      return result;
    },
    addSurveyPoint(params) {
      const id = emitSurveyPoint(params, ctx);
      host.trackSiteProduct(id, 'IfcAnnotation', params.Name ?? undefined);
      return id;
    },
    addPropertySet(productId, params) {
      return emitSurveyPropertySet(productId, params, ctx);
    },
    setGeoreferencing(params) {
      host.claimGeoreferencing();
      return emitGeoreferencing({ ...params, MapUnitRef: params.MapUnitRef ?? host.lengthUnitRef() }, ctx);
    },
  };
}
