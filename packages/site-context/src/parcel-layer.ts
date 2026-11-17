/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The parcel layer: the cadastral parcel(s) of the site as draped ribbons,
 * with attributes laid out for `Pset_LandRegistration` and the ÖREB extract
 * link. A failed ÖREB lookup is an issue on this layer, not a failed build.
 */

import type { Attribution, OerebExtractRef, SwissParcel } from '@ifc-lite/geodata-ch';
import { buildParcelRibbon, parcelCentre } from './parcel-mesh.js';
import type { TerrainGrid } from './terrain-mesh.js';
import type { MapPoint, SiteContextFeature, SiteContextGeodata, SiteContextIssue, SiteContextLayer } from './types.js';

export interface ParcelLayerInput {
  geodata: SiteContextGeodata;
  /** Where to look up the parcel when no EGRID is given. */
  point: MapPoint;
  egrid?: string;
  grid: TerrainGrid | null;
  h0: number;
  signal?: AbortSignal;
  onOereb?: () => void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
}

/** Ring centroid by area; the vertex mean for a degenerate ring. */
export function footprintCentroid(footprint: MapPoint[][]): MapPoint {
  const ring = footprint[0] ?? [];
  if (ring.length === 0) throw new RangeError('subject.footprint has no vertices');
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    return { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, y: ring.reduce((s, p) => s + p.y, 0) / ring.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

function mergeAttribution(into: Attribution[], more: readonly Attribution[]): void {
  for (const a of more) if (!into.some((b) => b.datasetId === a.datasetId && b.text === a.text)) into.push(a);
}

function parcelFeature(parcel: SwissParcel, oereb: OerebExtractRef | null, lookup: string, input: ParcelLayerInput) {
  const [cx, cy] = parcelCentre(parcel.geometry);
  const origin: [number, number, number] = [Math.round(cx), Math.round(cy), input.h0];
  const ribbon = input.grid ? buildParcelRibbon(parcel.geometry, input.grid, origin) : null;
  const feature: SiteContextFeature = {
    id: `parcel:${parcel.egrid}`,
    ifcType: 'IfcSite',
    name: parcel.number ? `Parcel ${parcel.number} (${parcel.egrid})` : `Parcel ${parcel.egrid}`,
    origin,
    mesh: ribbon?.mesh ?? null,
    attributes: {
      Pset_LandRegistration: { LandID: parcel.egrid, LandTitleID: parcel.number },
      egrid: parcel.egrid,
      number: parcel.number,
      canton: parcel.canton,
      cadastralDistrict: parcel.cadastralDistrict,
      realEstateType: parcel.realEstateType,
      area: parcel.computedArea,
      areaKind: 'planar area of the returned geometry, computed; not the registered legal area',
      sourceLayer: parcel.sourceLayer,
      geoportalUrl: parcel.geoportalUrl,
      oerebExtractUrl: oereb?.urls.url ?? null,
      oerebExtractPdfUrl: oereb?.urls.pdf ?? null,
      oerebSource: oereb?.source ?? null,
    },
    provenance: { dataset: 'cadastre', sourceLayer: parcel.sourceLayer, crs: parcel.crs, lookup },
  };
  return { feature, ribbon };
}

export async function parcelLayer(input: ParcelLayerInput): Promise<SiteContextLayer> {
  const { geodata, signal } = input;
  const issues: SiteContextIssue[] = [];
  const attribution: Attribution[] = [];
  let complete = true;
  let parcels: SwissParcel[];
  let lookup: string;
  try {
    if (input.egrid) {
      lookup = `parcelById(${input.egrid})`;
      const p = await geodata.parcelById(input.egrid, { signal });
      parcels = p ? [p] : [];
    } else {
      lookup = `parcelsAtPoint(${input.point.x}, ${input.point.y})`;
      parcels = await geodata.parcelsAtPoint(input.point.x, input.point.y, { signal });
    }
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    return {
      kind: 'parcel',
      features: [],
      attribution,
      issues: [{ code: 'parcel-lookup-failed', severity: 'error', message: `parcel lookup failed: ${message(err)}` }],
      complete: false,
    };
  }
  if (parcels.length === 0) {
    issues.push({
      code: 'parcel-not-found',
      severity: 'warning',
      message: input.egrid ? `no parcel with EGRID ${input.egrid}` : `no parcel contains the point (${input.point.x}, ${input.point.y})`,
    });
    complete = false;
  }
  if (parcels.length > 1) {
    issues.push({ code: 'parcel-overlapping', severity: 'info', message: `${parcels.length} parcels contain the point (overlapping rights); all are included`, count: parcels.length });
  }
  if (!input.grid && parcels.length > 0) {
    issues.push({ code: 'parcel-not-draped', severity: 'warning', message: 'no terrain grid to drape the boundary on; the parcel carries its data but no geometry' });
    complete = false;
  }

  const features: SiteContextFeature[] = [];
  for (const parcel of parcels) {
    mergeAttribution(attribution, parcel.attribution);
    let oereb: OerebExtractRef | null = null;
    input.onOereb?.();
    try {
      oereb = await geodata.oerebExtract(parcel.egrid, { signal });
      if (oereb) mergeAttribution(attribution, oereb.attribution);
      else issues.push({ code: 'oereb-not-found', severity: 'info', message: `no ÖREB extract service is known for ${parcel.egrid}` });
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      issues.push({ code: 'oereb-lookup-failed', severity: 'warning', message: `ÖREB lookup for ${parcel.egrid} failed: ${message(err)}` });
      complete = false;
    }
    const { feature, ribbon } = parcelFeature(parcel, oereb, lookup, input);
    if (ribbon && ribbon.undraped > 0) {
      issues.push({
        code: 'parcel-undraped-vertices',
        severity: 'warning',
        message: `${ribbon.undraped} of ${ribbon.points} boundary vertices of ${parcel.egrid} lie over missing terrain or outside the site; the ribbon breaks there`,
        count: ribbon.undraped,
      });
      complete = false;
    }
    features.push(feature);
  }
  for (const a of attribution) {
    if (a.termsVerifiedOn === null) {
      issues.push({
        code: 'terms-unverified',
        severity: 'warning',
        message: `terms of use for "${a.text}" (${a.datasetId}) are not verified: ${a.restrictions.join('; ')}`,
      });
    }
  }
  return { kind: 'parcel', features, attribution, issues, complete };
}
