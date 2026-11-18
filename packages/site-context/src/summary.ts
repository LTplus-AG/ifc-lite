/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Counts and the facts a consumer prints next to a site context, from the document alone. */

import type { Attribution } from '@ifc-lite/geodata-ch';
import { BUILDING_SET } from './buildings-layer.js';
import type { JsonValue, SiteContextDocument, SiteContextIssue, SiteContextLayer, SiteContextLayerKind, SiteContextOriginHeight } from './types.js';

export interface SiteContextLayerSummary {
  kind: SiteContextLayerKind;
  complete: boolean;
  features: number;
  triangles: number;
  vertices: number;
  attribution: Attribution[];
  issues: SiteContextIssue[];
}

export interface SiteContextParcelSummary {
  egrid: string;
  number: string | null;
  canton: string | null;
  oerebExtractUrl: string | null;
}

export interface SiteContextBuildingsSummary {
  count: number;
  withEgid: number;
  /**
   * The subject building and how it was matched; `null` when none was marked. `ids` lists every
   * feature marked subject: one building (EGID) can be several objects in the tiles.
   */
  subject: { id: string; ids: string[]; egid: string | null; match: JsonValue } | null;
  /** Network requests and bytes of the tile read (cache hits are free), from the layer provenance. */
  requests: number | null;
  bytes: number | null;
  cacheHits: number | null;
  /** Count per part name over all buildings (`roof`, `wall`), in triangles. */
  partTriangles: { [part: string]: number };
}

export interface SiteContextSummary {
  crs: 'EPSG:2056';
  verticalCrs: 'EPSG:5728';
  origin: [number, number, number];
  /** What H0 is: the terrain height at the centre, or `null` with the reason (absent for older files). */
  originHeight?: SiteContextOriginHeight;
  layers: SiteContextLayerSummary[];
  parcels: SiteContextParcelSummary[];
  /** Present when the document has a buildings layer. */
  buildings?: SiteContextBuildingsSummary;
}

function str(v: JsonValue | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: JsonValue | undefined): number | null {
  return typeof v === 'number' ? v : null;
}

function egidOf(attributes: { [key: string]: JsonValue }): string | null {
  const set = attributes[BUILDING_SET];
  return set && typeof set === 'object' && !Array.isArray(set) ? str(set.EGID) : null;
}

function buildingsSummary(layer: SiteContextLayer): SiteContextBuildingsSummary {
  const partTriangles: { [part: string]: number } = {};
  let withEgid = 0;
  let subject: SiteContextBuildingsSummary['subject'] = null;
  for (const f of layer.features) {
    const egid = egidOf(f.attributes);
    if (egid !== null) withEgid++;
    if (f.subject) {
      if (subject) subject.ids.push(f.id);
      else subject = { id: f.id, ids: [f.id], egid, match: f.provenance.subjectMatch ?? null };
    }
    for (const p of f.mesh?.parts ?? []) partTriangles[p.name] = (partTriangles[p.name] ?? 0) + p.indexCount / 3;
  }
  const prov = layer.provenance ?? {};
  return { count: layer.features.length, withEgid, subject, requests: num(prov.requests), bytes: num(prov.bytes), cacheHits: num(prov.cacheHits), partTriangles };
}

export function summarizeSiteContext(doc: SiteContextDocument): SiteContextSummary {
  const parcels: SiteContextParcelSummary[] = [];
  const layers = doc.layers.map((layer) => {
    let triangles = 0;
    let vertices = 0;
    for (const f of layer.features) {
      if (f.mesh) {
        triangles += f.mesh.indices.length / 3;
        vertices += f.mesh.positions.length / 3;
      }
      if (layer.kind === 'parcel') {
        const egrid = str(f.attributes.egrid);
        if (egrid) {
          parcels.push({
            egrid,
            number: str(f.attributes.number),
            canton: str(f.attributes.canton),
            oerebExtractUrl: str(f.attributes.oerebExtractUrl),
          });
        }
      }
    }
    return {
      kind: layer.kind,
      complete: layer.complete,
      features: layer.features.length,
      triangles,
      vertices,
      attribution: layer.attribution,
      issues: layer.issues,
    };
  });
  const buildings = doc.layers.find((l) => l.kind === 'buildings');
  return { crs: doc.crs, verticalCrs: doc.verticalCrs, origin: doc.origin, ...(doc.originHeight ? { originHeight: doc.originHeight } : {}), layers, parcels, ...(buildings ? { buildings: buildingsSummary(buildings) } : {}) };
}
