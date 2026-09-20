/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Explicit CRS identifiers read from WKT1/WKT2 without guessing a CRS. */
export interface WktCrsIdentifiers { horizontalId?: string; verticalId?: string }
export type WktAxisDirection = 'east' | 'west' | 'north' | 'south' | 'up' | 'down';
export interface WktSpatialMetadata extends WktCrsIdentifiers {
  axes?: readonly [WktAxisDirection, WktAxisDirection, WktAxisDirection];
  horizontalUnitToMetres?: number;
  verticalUnitToMetres?: number;
}
interface WktNode { name: string; body: string }

/** Balanced lexical nodes; metadata is read only from direct owned children. */
function nodes(text: string): WktNode[] {
  const result: WktNode[] = [];
  for (let index = 0; index < text.length;) {
    const match = /([A-Za-z_][A-Za-z_0-9]*)\s*\[/.exec(text.slice(index));
    if (!match) break;
    const start = index + match.index, bodyStart = start + match[0].length;
    let depth = 1, quote = false, cursor = bodyStart;
    for (; cursor < text.length && depth > 0; cursor += 1) {
      const char = text[cursor];
      if (char === '"') quote = !quote;
      else if (!quote && char === '[') depth += 1;
      else if (!quote && char === ']') depth -= 1;
    }
    if (depth !== 0) break;
    result.push({ name: match[1].toUpperCase(), body: text.slice(bodyStart, cursor - 1) });
    index = cursor;
  }
  return result;
}
function direct(body: string, names: readonly string[]): WktNode | undefined {
  const allowed = new Set(names);
  return nodes(body).find((node) => allowed.has(node.name));
}
function root(wkt: string): WktNode | undefined { return nodes(wkt)[0]; }
function epsg(node: WktNode | undefined): string | undefined {
  const owned = node && direct(node.body, ['ID', 'AUTHORITY']);
  const code = owned?.body.match(/^\s*["']EPSG["']\s*,\s*["']?(\d+)/i)?.[1];
  return code ? `EPSG:${code}` : undefined;
}
function axes(node: WktNode | undefined): WktAxisDirection[] {
  return node ? nodes(node.body).filter((child) => child.name === 'AXIS')
    .map((child) => /^[^,]*,\s*(east|west|north|south|up|down)\b/i.exec(child.body)?.[1]?.toLowerCase())
    .filter((value): value is WktAxisDirection => value !== undefined) : [];
}
function unit(node: WktNode | undefined): number | undefined {
  const owned = node && direct(node.body, ['LENGTHUNIT', 'UNIT']);
  const number = Number(owned && /,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(owned.body)?.[1]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function extractWktSpatialMetadata(wkt: string): WktSpatialMetadata {
  const document = root(wkt);
  if (!document) return {};
  const compound = ['COMPOUNDCRS', 'COMPD_CS'].includes(document.name) ? document : undefined;
  const scope = compound?.body ?? wkt;
  // E57 coordinateMetadata commonly stores adjacent top-level PROJCRS and
  // VERTCRS nodes rather than wrapping them in COMPOUNDCRS.
  const horizontal = direct(scope, ['PROJCRS', 'PROJCS', 'GEOGCRS', 'GEOGCS']);
  const vertical = direct(scope, ['VERTCRS', 'VERT_CS']);
  const horizontalAxes = axes(horizontal).filter((value) => value !== 'up' && value !== 'down');
  // LAS has a third Z ordinate; when WKT describes only its horizontal CRS,
  // retain its documented positive-height convention rather than borrowing a
  // nested GEOGCS axis. A declared VERTCRS still owns the direction.
  const verticalAxis = axes(vertical ?? horizontal).find((value) => value === 'up' || value === 'down')
    ?? (!vertical ? 'up' : undefined);
  const frame = horizontalAxes.length === 2 && new Set(horizontalAxes).size === 2 && verticalAxis
    ? [horizontalAxes[0], horizontalAxes[1], verticalAxis] as const : undefined;
  const horizontalId = epsg(horizontal), verticalId = epsg(vertical);
  const horizontalUnitToMetres = unit(horizontal), verticalUnitToMetres = unit(vertical);
  return {
    ...(horizontalId ? { horizontalId } : {}), ...(verticalId ? { verticalId } : {}),
    ...(frame ? { axes: frame } : {}), ...(horizontalUnitToMetres ? { horizontalUnitToMetres } : {}),
    ...(verticalUnitToMetres ? { verticalUnitToMetres } : {}),
  };
}
export function extractWktCrsIdentifiers(wkt: string): WktCrsIdentifiers {
  const { horizontalId, verticalId } = extractWktSpatialMetadata(wkt);
  return { ...(horizontalId ? { horizontalId } : {}), ...(verticalId ? { verticalId } : {}) };
}
