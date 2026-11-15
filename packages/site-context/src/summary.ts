/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Counts and the facts a consumer prints next to a site context, from the document alone. */

import type { Attribution } from '@ifc-lite/geodata-ch';
import type { JsonValue, SiteContextDocument, SiteContextIssue, SiteContextLayerKind } from './types.js';

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

export interface SiteContextSummary {
  crs: 'EPSG:2056';
  verticalCrs: 'EPSG:5728';
  origin: [number, number, number];
  layers: SiteContextLayerSummary[];
  parcels: SiteContextParcelSummary[];
}

function str(v: JsonValue | undefined): string | null {
  return typeof v === 'string' ? v : null;
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
  return { crs: doc.crs, verticalCrs: doc.verticalCrs, origin: doc.origin, layers, parcels };
}
