/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The buildings layer: neighbouring buildings from swissBUILDINGS3D (3D
 * Tiles) as meshes in the site frame, one feature per building, with a roof
 * part and a wall part, attributes in `IfcLite_SiteContextBuilding`, and the
 * model's own building marked `subject`. Whole buildings are kept when their
 * footprint touches the site square; nothing is cut at the boundary.
 */

import { DATASETS } from '@ifc-lite/geodata-ch';
import { readSwisstopoBuildings, swisstopoBuildingsTilesetUrl, swisstopoRelease, type SwisstopoBuildingsResult } from '@ifc-lite/tiles3d';
import { baseFootprint, hullCentre, hullTouchesBox, matchFootprint, SUBJECT_MIN_OVERLAP } from './buildings-footprint.js';
import { buildBuildingMesh } from './buildings-mesh.js';
import { ecefToLv95, HEIGHT_CHECK_TOLERANCE, isRoofColour, lv95Transformer, numberOrNull, siteRegion, textOrNull } from './buildings-convert.js';
import { readerIssues } from './buildings-issues.js';
import type { BuildingsOptions, JsonValue, MapPoint, SiteContextFeature, SiteContextIssue, SiteContextLayer } from './types.js';

/** The custom property set the attributes go in (not a buildingSMART `Pset_`). */
export const BUILDING_SET = 'IfcLite_SiteContextBuilding';
export const DEFAULT_MAX_BUILDINGS = 5000;
export const DEFAULT_MAX_BUILDING_TRIANGLES = 2_000_000;

export interface BuildingsLayerInput {
  centre: MapPoint;
  radius: number;
  subject?: { footprint?: MapPoint[][]; egid?: string };
  options?: BuildingsOptions;
  signal?: AbortSignal;
}

interface Candidate {
  feature: SiteContextFeature;
  hull: MapPoint[];
  distance: number;
  triangles: number;
  egid: string | null;
  /** The id suffix that keeps the id unique when several buildings share this EGID. */
  own: string;
  /** |measured top − DACH_MAX| in metres, `null` without DACH_MAX. */
  heightOff: number | null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failed(code: string, text: string): SiteContextLayer {
  return { kind: 'buildings', features: [], attribution: [], issues: [{ code, severity: 'error', message: text }], complete: false };
}

export async function buildingsLayer(input: BuildingsLayerInput): Promise<SiteContextLayer> {
  const { centre, radius, signal } = input;
  const o = input.options ?? {};
  const maxFeatures = o.maxFeatures ?? DEFAULT_MAX_BUILDINGS;
  const maxTriangles = o.maxTriangles ?? DEFAULT_MAX_BUILDING_TRIANGLES;
  const box = { minX: centre.x - radius, minY: centre.y - radius, maxX: centre.x + radius, maxY: centre.y + radius };
  const t = await lv95Transformer();
  const region = siteRegion(box, t);
  const reader = o.reader ?? readSwisstopoBuildings;
  let res: SwisstopoBuildingsResult;
  try {
    res = await reader({
      region,
      signal,
      release: o.release,
      fetch: o.fetch,
      cache: o.cache,
      maxRequests: o.maxRequests,
      maxBytes: o.maxBytes,
      tileCullMarginMetres: o.tileCullMarginMetres,
      dracoModuleOptions: o.dracoModuleOptions,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    return failed('buildings-fetch-failed', `buildings could not be read: ${message(err)}`);
  }

  const issues: SiteContextIssue[] = readerIssues(res);
  let complete = res.complete;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let outside = 0, duplicates = 0, unmapped = 0, degenerate = 0, unknownMaterial = 0, repeatedFaces = 0, interiorFaces = 0;
  for (const f of res.features) {
    const xyz = ecefToLv95(f.positions, t);
    if (!xyz) {
      unmapped++;
      continue;
    }
    const hull = baseFootprint(xyz);
    if (!hullTouchesBox(hull, box)) {
      outside++;
      continue;
    }
    const a = f.attributes;
    const egid = textOrNull(a.EGID);
    const uuid = textOrNull(a.UUID);
    const release = swisstopoRelease(f.tile) ?? null;
    const key = uuid ?? `${f.tile.url}#${f.featureId}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);

    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < xyz.length; i += 3) {
      zmin = Math.min(zmin, xyz[i + 2]);
      zmax = Math.max(zmax, xyz[i + 2]);
    }
    const c = hullCentre(hull);
    const origin: [number, number, number] = [Math.round(c.x), Math.round(c.y), Math.round(zmin)];
    const local = new Float64Array(xyz.length);
    for (let i = 0; i < xyz.length; i += 3) {
      local[i] = xyz[i] - origin[0];
      local[i + 1] = xyz[i + 1] - origin[1];
      local[i + 2] = xyz[i + 2] - origin[2];
    }
    const partOf = new Uint8Array(f.indices.length / 3).fill(1);
    for (const g of f.groups) {
      const roof = isRoofColour(g.baseColorFactor);
      if (roof === null) unknownMaterial++;
      if (roof) partOf.fill(0, g.start / 3, (g.start + g.count) / 3);
    }
    const built = buildBuildingMesh({ positions: local, indices: f.indices, partOf });
    degenerate += built.degenerate;
    repeatedFaces += built.duplicates;
    interiorFaces += built.interior;

    const roofMax = numberOrNull(a.DACH_MAX);
    const objectType = textOrNull(a.OBJEKTART);
    const own = uuid ? `uuid:${uuid}` : key;
    // Final when the EGID is unique in the site; made unique below when it is not.
    const id = `building:${egid ? `egid:${egid}` : own}`;
    const attrs: { [k: string]: JsonValue } = {
      EGID: egid,
      UUID: uuid,
      ObjectType: objectType,
      TotalHeight: numberOrNull(a.GESAMTHOEHE),
      RoofMin: numberOrNull(a.DACH_MIN),
      RoofMax: roofMax,
      TerrainPoint: numberOrNull(a.GELAENDEPUNKT),
      DatasetRelease: release,
      SourceTile: f.tile.url,
    };
    candidates.push({
      feature: {
        id,
        ifcType: 'IfcBuilding',
        name: `${objectType ?? 'Building'}${egid ? ` (EGID ${egid})` : ''}`,
        origin,
        mesh: built.mesh,
        attributes: { [BUILDING_SET]: attrs },
        provenance: {
          dataset: 'swissBUILDINGS3D (3D Tiles)',
          release,
          tile: f.tile.url,
          featureId: f.featureId,
          tilesetChain: f.tile.tilesetChain,
          footprint: 'convex hull of the vertices in the lowest quarter of the building height',
          measuredTop: zmax,
          heightCheck: roofMax === null ? 'no DACH_MAX to compare' : `top − DACH_MAX = ${(zmax - roofMax).toFixed(3)} m`,
        },
      },
      hull,
      distance: Math.hypot(c.x - centre.x, c.y - centre.y),
      triangles: built.mesh.indices.length / 3,
      egid,
      own,
      heightOff: roofMax === null ? null : Math.abs(zmax - roofMax),
    });
  }

  // swissBUILDINGS3D can split one building (one EGID) into several objects, each with its own
  // UUID. Every emitted feature needs its own id (the viewer derives a GlobalId from it), so a
  // shared EGID keeps the EGID and adds the object's UUID; the EGID stays in the attributes.
  const perEgid = new Map<string, number>();
  for (const c of candidates) if (c.egid) perEgid.set(c.egid, (perEgid.get(c.egid) ?? 0) + 1);
  for (const c of candidates) if (c.egid && perEgid.get(c.egid)! > 1) c.feature.id = `building:egid:${c.egid}:${c.own}`;

  // The subject: EGID first, then footprint overlap.
  const subject = input.subject;
  let match: { [k: string]: JsonValue } | null = null;
  let subjectIndex = -1;
  if (subject?.egid) {
    const want = subject.egid.trim();
    subjectIndex = candidates.findIndex((c) => c.egid === want);
    if (subjectIndex >= 0) match = { method: 'egid', egid: want };
  }
  if (subjectIndex < 0 && subject?.footprint?.length) {
    const { best, bestOverlap } = matchFootprint(subject.footprint, candidates.map((c, index) => ({ index, hull: c.hull })));
    if (best) {
      subjectIndex = best.index;
      match = { method: 'footprint', overlap: Math.round(best.overlap * 1000) / 1000, threshold: SUBJECT_MIN_OVERLAP, otherCandidatesAboveThreshold: best.alsoAbove };
    } else {
      match = null;
      issues.push({
        code: 'buildings-subject-not-found',
        severity: 'warning',
        message: `no building overlaps the model footprint by ${SUBJECT_MIN_OVERLAP * 100} % or more (best ${(bestOverlap * 100).toFixed(1)} %)${subject.egid ? ` and none has EGID ${subject.egid}` : ''}`,
      });
    }
  } else if (subjectIndex < 0 && subject?.egid) {
    issues.push({ code: 'buildings-subject-not-found', severity: 'warning', message: `no building in the site has EGID ${subject.egid}, and no footprint was given to match by` });
  }
  if (subjectIndex >= 0) {
    // Every object of the matched building: all of them when it has an EGID they share.
    const matched = candidates[subjectIndex];
    const parts = matched.egid ? candidates.filter((c) => c.egid === matched.egid) : [matched];
    for (const s of parts) {
      s.feature.subject = true;
      s.feature.provenance.subjectMatch = match;
    }
    const ids = parts.map((s) => s.feature.id).join(', ');
    issues.push({ code: 'buildings-subject-matched', severity: 'info', message: `the model's own building is ${ids}, matched by ${match!.method}; it is marked subject, not removed` });
  }

  // Caps: nearest the centre first. The subject is always kept, whatever the caps, since a
  // reported match must have its building in the layer (#10480 review).
  candidates.sort((x, y) => Number(y.feature.subject === true) - Number(x.feature.subject === true) || x.distance - y.distance);
  const features: SiteContextFeature[] = [];
  const kept: Candidate[] = [];
  let triangles = 0;
  let cappedBy: 'features' | 'triangles' | null = null;
  for (const c of candidates) {
    if (c.feature.subject) {
      features.push(c.feature);
      kept.push(c);
      triangles += c.triangles;
    } else if (features.length >= maxFeatures) cappedBy ??= 'features';
    else if (triangles + c.triangles > maxTriangles) cappedBy ??= 'triangles';
    else {
      features.push(c.feature);
      kept.push(c);
      triangles += c.triangles;
    }
  }
  if (cappedBy) {
    complete = false;
    issues.push({
      code: 'buildings-truncated',
      severity: 'warning',
      message: `${candidates.length - features.length} of ${candidates.length} buildings left out by the ${cappedBy === 'features' ? `building cap (${maxFeatures})` : `triangle cap (${maxTriangles})`}; the nearest to the centre were kept`,
      count: candidates.length - features.length,
    });
  }

  const noEgid = features.filter((f) => (f.attributes[BUILDING_SET] as { EGID: JsonValue }).EGID === null).length;
  if (noEgid > 0) issues.push({ code: 'buildings-missing-egid', severity: 'info', message: `${noEgid} of ${features.length} buildings have no EGID in the tiles`, count: noEgid });
  const noHeights = features.filter((f) => {
    const s = f.attributes[BUILDING_SET] as { [k: string]: JsonValue };
    return s.RoofMax === null || s.RoofMin === null || s.TerrainPoint === null || s.TotalHeight === null;
  }).length;
  if (noHeights > 0) {
    issues.push({ code: 'buildings-missing-heights', severity: 'info', message: `${noHeights} of ${features.length} buildings lack some of GESAMTHOEHE, DACH_MIN, DACH_MAX, GELAENDEPUNKT`, count: noHeights });
  }
  // The height check over the buildings kept, not those the caps left out (#10480 review).
  const offs = kept.map((c) => c.heightOff).filter((d): d is number => d !== null);
  const heightMismatch = offs.filter((d) => d > HEIGHT_CHECK_TOLERANCE).length;
  const worstHeight = offs.reduce((w, d) => Math.max(w, d), 0);
  if (heightMismatch > 0) {
    const broken = worstHeight > 1;
    if (broken) complete = false;
    issues.push({
      code: 'buildings-height-check',
      severity: broken ? 'error' : 'warning',
      message: `${heightMismatch} buildings' tops differ from their DACH_MAX by more than ${HEIGHT_CHECK_TOLERANCE} m (worst ${worstHeight.toFixed(2)} m): the tiles may no longer store LN02 heights, so the heights here may be wrong`,
      count: heightMismatch,
    });
  }
  const counted: Array<[number, string, string]> = [
    [unmapped, 'buildings-unmapped', 'buildings had a vertex that does not map to EPSG:2056 and were left out'],
    [duplicates, 'buildings-duplicate', 'buildings appeared twice (same UUID) and were kept once'],
    [degenerate, 'buildings-degenerate-triangles', 'zero-area triangles were left out of the meshes'],
    [repeatedFaces, 'buildings-repeated-faces', 'repeated copies of a face (the tiles store faces twice) were kept once'],
    [interiorFaces, 'buildings-interior-faces', 'faces shared by a wall solid and its roof solid (inside the building) were left out'],
    [unknownMaterial, 'buildings-material-unknown', 'triangle groups had no base colour; their triangles were put in the wall part'],
  ];
  for (const [count, code, text] of counted) if (count > 0) issues.push({ code, severity: code === 'buildings-unmapped' ? 'warning' : 'info', message: `${count} ${text}`, count });
  if (unmapped > 0) complete = false;

  return {
    kind: 'buildings',
    features,
    attribution: [{ ...DATASETS.swissbuildings3d, text: res.attribution }],
    issues,
    complete,
    provenance: {
      source: o.reader ? 'injected reader' : swisstopoBuildingsTilesetUrl(o.release),
      releases: [...new Set(res.tiles.map((tile) => swisstopoRelease(tile)).filter((r): r is string => r !== undefined))],
      conversion: `ECEF → geodetic (ecefToGeodetic) → EPSG:2056 via @ifc-lite/geo (datum shift: ${t.datumShift}); stored height taken as LN02, no geoid correction`,
      requests: res.stats.requests,
      bytes: res.stats.bytes,
      cacheHits: res.stats.cacheHits,
      tiles: res.tiles.length,
      readerFeatures: res.features.length,
      outsideSite: outside,
      kept: features.length,
      triangles,
      maxFeatures,
      maxTriangles,
      truncated: res.truncated || cappedBy !== null,
      subjectMatch: match,
    },
  };
}
