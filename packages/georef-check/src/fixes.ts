/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Building suggested fixes. Every fix goes through {@link makeFix}, which
 * derives how it can be applied from its changes, so no detector can state a
 * fix without saying whether the georeferencing write API (`bim.georef.set` /
 * `update`) can carry it. The rules mirror that API's refusals: it edits the
 * model's one effective IfcMapConversion / IfcProjectedCRS (or the IFC2X3
 * ePSets) without entity ids, and an IfcSite's RefLatitude/RefLongitude/
 * RefElevation (`setSite`); never IfcRigidOperation, placements or
 * an IfcGeographicCRS, refuses an update when the file has several map
 * conversions, a CRS defined by WKT, and a CRS rename that does not restate
 * the old CRS's other fields.
 */

import { crsChange, isIfc2x3, round, type DiagnosisContext } from './context.js';
import type { CrsFact, FieldChange, FixApplication, GeorefSiteWriteInput, GeorefWriteInput, SuggestedFix, Vec3 } from './types.js';

const OPERATION_ENTITIES: ReadonlySet<FieldChange['entity']> = new Set(['IfcMapConversion', 'IfcMapConversionScaled', 'ePSet_MapConversion']);
const CRS_ENTITIES: ReadonlySet<FieldChange['entity']> = new Set(['IfcProjectedCRS', 'ePSet_ProjectedCRS']);

/** The IfcSite attributes `bim.georef.setSite` writes. */
const SITE_ATTRIBUTES: ReadonlySet<string> = new Set(['RefLatitude', 'RefLongitude', 'RefElevation']);

const MANUAL_REASONS: Partial<Record<FieldChange['entity'], string>> = {
  IfcSite: 'An IfcSite change that is not only RefLatitude/RefLongitude/RefElevation, or that comes with other changes, is not one georeferencing write; apply it in parts or in the authoring tool.',
  IfcCartesianPoint: 'Placements are not part of the georeferencing write API; edit the point in the authoring tool or with a generic attribute edit.',
  IfcRigidOperation: 'The georeferencing write API does not edit an IfcRigidOperation (set with replace would swap it for an IfcMapConversion).',
  IfcGeographicCRS: 'The georeferencing write API edits an IfcProjectedCRS, not an IfcGeographicCRS.',
};

/** CrsFact field → EXPRESS attribute, for the fields a rename must restate. */
const CRS_CARRIED: ReadonlyArray<[keyof CrsFact, string]> = [
  ['description', 'Description'], ['geodeticDatum', 'GeodeticDatum'], ['verticalDatum', 'VerticalDatum'],
  ['mapProjection', 'MapProjection'], ['mapZone', 'MapZone'], ['mapUnit', 'MapUnit'],
];

function manual(reason: string): FixApplication {
  return { via: 'manual', reason };
}

/** How `changes` can be applied; see the module comment for the rules. */
export function applicationOf(ctx: DiagnosisContext, changes: readonly FieldChange[]): FixApplication {
  const site = siteApplication(changes);
  if (site) return site;
  for (const c of changes) {
    const reason = MANUAL_REASONS[c.entity];
    if (reason) return manual(reason);
  }
  const op = ctx.operation;
  const crs = ctx.crs;
  // Whole-model refusals: update edits an IfcMapConversion and an IfcProjectedCRS only.
  if (op?.source === 'IfcRigidOperation') return manual(MANUAL_REASONS.IfcRigidOperation as string);
  if (crs?.source === 'IfcGeographicCRS') return manual(MANUAL_REASONS.IfcGeographicCRS as string);
  for (const c of changes) {
    const target = OPERATION_ENTITIES.has(c.entity) ? op : crs;
    if (c.entityId !== undefined && c.entityId !== target?.entityId) {
      return manual(`#${c.entityId} is not the record the georeferencing write API edits (it addresses the model's effective georeferencing, not entity ids).`);
    }
  }
  const touchesCrs = changes.some((c) => CRS_ENTITIES.has(c.entity));
  if (touchesCrs && crs?.wellKnownText) {
    return manual(`${crs.source} #${crs.entityId} is defined by an IfcWellKnownText; the write API refuses to edit its attributes (set with replace rewrites it).`);
  }
  const conversions = ctx.facts.additionalMapConversions?.length ?? 0;
  if (conversions > 1 && !isIfc2x3(ctx.facts.schemaVersion) && (op || crs)) {
    return manual(`The file has ${conversions} IfcMapConversion records; the write API's update refuses that as ambiguous (delete the extra ones first, or set with replace).`);
  }

  const input: GeorefWriteInput = {};
  for (const c of changes) {
    if (OPERATION_ENTITIES.has(c.entity)) {
      input.MapConversion ??= {};
      input.MapConversion[c.attribute] = typeof c.value === 'number' ? c.value : null;
    } else {
      input.ProjectedCRS ??= {};
      input.ProjectedCRS[c.attribute] = c.value === null ? null : String(c.value);
    }
  }
  // A rename must restate the old CRS's other fields, or update refuses it
  // rather than keep a datum or unit that belongs to the old CRS.
  const newName = input.ProjectedCRS?.Name;
  if (crs && input.ProjectedCRS && newName !== undefined && (newName === null || newName.trim() !== crs.name.trim())) {
    for (const [field, attribute] of CRS_CARRIED) {
      if (crs[field] !== undefined && !(attribute in input.ProjectedCRS)) input.ProjectedCRS[attribute] = null;
    }
  }
  const userSupplied = [
    ...Object.entries(input.ProjectedCRS ?? {}).filter(([, v]) => v === null).map(([k]) => `ProjectedCRS.${k}`),
    ...Object.entries(input.MapConversion ?? {}).filter(([, v]) => v === null).map(([k]) => `MapConversion.${k}`),
  ];
  return !op && !crs
    ? { via: 'georef.set', input, userSupplied }
    : { via: 'georef.update', input, userSupplied };
}

/**
 * A fix made only of IfcSite RefLatitude/RefLongitude/RefElevation changes on
 * one site is one `bim.georef.setSite` call (decimal degrees; the write layer
 * encodes the compound angle).
 */
function siteApplication(changes: readonly FieldChange[]): FixApplication | undefined {
  if (changes.length === 0 || !changes.every((c) => c.entity === 'IfcSite' && SITE_ATTRIBUTES.has(c.attribute))) return undefined;
  const siteIds = new Set(changes.map((c) => c.entityId));
  if (siteIds.size !== 1) return undefined;
  const siteId = changes[0].entityId;
  const input: GeorefSiteWriteInput = siteId === undefined ? {} : { siteId };
  const userSupplied: string[] = [];
  for (const c of changes) {
    const attribute = c.attribute as 'RefLatitude' | 'RefLongitude' | 'RefElevation';
    if (typeof c.value === 'number') input[attribute] = c.value;
    else {
      input[attribute] = null;
      userSupplied.push(`IfcSite.${attribute}`);
    }
  }
  return { via: 'georef.site', input, userSupplied };
}

export function makeFix(ctx: DiagnosisContext, summary: string, changes: FieldChange[], caveat?: string): SuggestedFix {
  const fix: SuggestedFix = { summary, changes, apply: applicationOf(ctx, changes) };
  if (caveat) fix.caveat = caveat;
  return fix;
}

/**
 * The fields a new georeferencing needs, valued `null` where only the user
 * knows the answer: one grouped `bim.georef.set` (or an update that adds the
 * conversion beside an existing CRS). A CRS the file already names is kept.
 */
export function newMapConversionChanges(ctx: DiagnosisContext, values?: { e: number; n: number; h: number }): FieldChange[] {
  const ePSet = isIfc2x3(ctx.facts.schemaVersion);
  const opEntity = ePSet ? 'ePSet_MapConversion' : 'IfcMapConversion';
  const changes: FieldChange[] = [];
  // A CRS with no Name and no WKT identifies no map: it still needs its Name.
  const named = !!ctx.crs && (ctx.crs.name.trim() !== '' || !!ctx.crs.wellKnownText);
  if (!named) changes.push(crsChange(ctx.crs, 'Name', null, ePSet));
  changes.push(
    { entity: opEntity, attribute: 'Eastings', value: values ? round(values.e) : null },
    { entity: opEntity, attribute: 'Northings', value: values ? round(values.n) : null },
    { entity: opEntity, attribute: 'OrthogonalHeight', value: values ? round(values.h) : null },
  );
  // Scale converts project units to map units. An existing CRS that states its
  // MapUnit fixes the map unit, so a project in other units needs the factor
  // (millimetres onto a metre grid: 0.001); an unset Scale means 1 and would
  // leave the model that much too large. With no MapUnit the map unit is the
  // project unit and 1 is right.
  const mapUnitScale = ctx.crs?.mapUnitScale;
  if (mapUnitScale !== undefined && mapUnitScale > 0 && Math.abs(ctx.lengthScale / mapUnitScale - 1) > 1e-9) {
    changes.push({ entity: opEntity, attribute: 'Scale', value: round(ctx.lengthScale / mapUnitScale, 12) });
  }
  return changes;
}

export function newMapConversionFix(ctx: DiagnosisContext): SuggestedFix {
  const ePSet = isIfc2x3(ctx.facts.schemaVersion);
  return makeFix(
    ctx,
    ePSet
      ? 'Add ePSet_MapConversion and ePSet_ProjectedCRS with the EPSG code and the map position of the project origin.'
      : 'Add an IfcMapConversion and IfcProjectedCRS with the EPSG code and the map position of the project origin.',
    newMapConversionChanges(ctx),
  );
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * The change that moves the site placement by `-shift` (world frame, project
 * units): the site's own Location point
 * (`IfcLocalPlacement.RelativePlacement` → `IfcAxis2Placement3D.Location` →
 * `IfcCartesianPoint.Coordinates`), with the shift expressed in the parent
 * frame when the placement has a `PlacementRelTo`. Undefined when the
 * Location point could not be read.
 */
export function siteMoveChange(ctx: DiagnosisContext, shift: Vec3): { change: FieldChange; caveat?: string } | undefined {
  const point = ctx.facts.coordinates?.siteLocationPoint;
  if (!point) return undefined;
  const axes = ctx.facts.coordinates?.siteParentAxes;
  const local = axes ? { x: dot(axes.x, shift), y: dot(axes.y, shift), z: dot(axes.z, shift) } : shift;
  const c = point.coordinates;
  return {
    change: { entity: 'IfcCartesianPoint', entityId: point.id, attribute: 'Coordinates', value: [round(c.x - local.x), round(c.y - local.y), round(c.z - local.z)] },
    caveat: point.sharedBy > 1
      ? `IfcCartesianPoint #${point.id} is the Location of ${point.sharedBy} placements; give the site placement its own point first, or every one of them moves.`
      : undefined,
  };
}
