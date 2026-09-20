/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Explicit CRS identifiers read from WKT1/WKT2 without guessing a CRS. */
export interface WktCrsIdentifiers {
  horizontalId?: string;
  verticalId?: string;
}

function nodeBody(wkt: string, names: readonly string[]): string | undefined {
  const token = new RegExp(`\\b(?:${names.join('|')})\\s*\\[`, 'ig');
  const match = token.exec(wkt);
  if (!match) return undefined;
  let depth = 1;
  let quoted = false;
  for (let index = token.lastIndex; index < wkt.length; index += 1) {
    const char = wkt[index];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '[') depth += 1;
    else if (char === ']' && --depth === 0) return wkt.slice(token.lastIndex, index);
  }
  return undefined;
}

function nodeEpsg(body: string | undefined): string | undefined {
  if (!body) return undefined;
  // A WKT node's final ID/AUTHORITY is its own CRS; earlier IDs can belong to
  // a nested base CRS, datum, or conversion.
  const ids = [...body.matchAll(/(?:ID|AUTHORITY)\s*\[\s*["']EPSG["']\s*,\s*["']?(\d+)/ig)];
  const code = ids.at(-1)?.[1];
  return code ? `EPSG:${code}` : undefined;
}

/**
 * Read only CRS nodes explicitly named by WKT. Supports WKT2 PROJCRS /
 * COMPOUNDCRS + VERTCRS and WKT1 PROJCS / VERT_CS. It intentionally returns
 * incomplete metadata when only one component was declared.
 */
export function extractWktCrsIdentifiers(wkt: string): WktCrsIdentifiers {
  const compound = nodeBody(wkt, ['COMPOUNDCRS', 'COMPD_CS']);
  const horizontal = nodeEpsg(nodeBody(compound ?? wkt, ['PROJCRS', 'PROJCS']))
    ?? nodeEpsg(nodeBody(compound ?? wkt, ['GEOGCRS', 'GEOGCS']));
  const vertical = nodeEpsg(nodeBody(compound ?? wkt, ['VERTCRS', 'VERT_CS']));
  return {
    ...(horizontal ? { horizontalId: horizontal } : {}),
    ...(vertical ? { verticalId: vertical } : {}),
  };
}
