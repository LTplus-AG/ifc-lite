/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Explicit CRS identifiers read from WKT1/WKT2 without guessing a CRS. */
export interface WktCrsIdentifiers {
  horizontalId?: string;
  verticalId?: string;
}

/** Native coordinate directions explicitly declared by a WKT AXIS node. */
export type WktAxisDirection = 'east' | 'west' | 'north' | 'south' | 'up' | 'down';

/** CRS identifiers plus the native coordinate frame declared by WKT. */
export interface WktSpatialMetadata extends WktCrsIdentifiers {
  /** X/Y/Z order and direction as authored, when WKT declares all three. */
  axes?: readonly [WktAxisDirection, WktAxisDirection, WktAxisDirection];
  /** Native projected horizontal coordinate unit, expressed in metres. */
  horizontalUnitToMetres?: number;
  /** Native vertical coordinate unit, expressed in metres. */
  verticalUnitToMetres?: number;
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

function axisDirections(body: string | undefined): WktAxisDirection[] {
  if (!body) return [];
  const directions: WktAxisDirection[] = [];
  const axis = /\bAXIS\s*\[\s*(?:"(?:[^"]|"")*"|'[^']*')\s*,\s*(east|west|north|south|up|down)\b/ig;
  for (const match of body.matchAll(axis)) {
    const direction = match[1]?.toLowerCase() as WktAxisDirection | undefined;
    if (direction) directions.push(direction);
  }
  return directions;
}

function lengthUnitToMetres(body: string | undefined): number | undefined {
  if (!body) return undefined;
  const units = /\b(?:LENGTHUNIT|UNIT)\s*\[\s*(?:"(?:[^"]|"")*"|'[^']*')\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/ig;
  const values = [...body.matchAll(units)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.at(-1);
}

function coordinateAxes(horizontal: string | undefined, vertical: string | undefined): WktSpatialMetadata['axes'] {
  const horizontalAxes = axisDirections(horizontal)
    .filter((direction) => direction !== 'up' && direction !== 'down');
  const verticalAxis = axisDirections(vertical ?? horizontal)
    .find((direction) => direction === 'up' || direction === 'down');
  const horizontalSet = new Set(horizontalAxes);
  if (horizontalAxes.length < 2 || horizontalSet.size !== 2 || !verticalAxis) return undefined;
  return [horizontalAxes[0], horizontalAxes[1], verticalAxis];
}

/**
 * Read only CRS nodes explicitly named by WKT. Supports WKT2 PROJCRS /
 * COMPOUNDCRS + VERTCRS and WKT1 PROJCS / VERT_CS. It intentionally returns
 * incomplete metadata when only one component was declared.
 */
export function extractWktSpatialMetadata(wkt: string): WktSpatialMetadata {
  const compound = nodeBody(wkt, ['COMPOUNDCRS', 'COMPD_CS']);
  const scope = compound ?? wkt;
  const horizontalNode = nodeBody(scope, ['PROJCRS', 'PROJCS'])
    ?? nodeBody(scope, ['GEOGCRS', 'GEOGCS']);
  const verticalNode = nodeBody(scope, ['VERTCRS', 'VERT_CS']);
  const horizontal = nodeEpsg(horizontalNode);
  const vertical = nodeEpsg(verticalNode);
  const axes = coordinateAxes(horizontalNode, verticalNode);
  const horizontalUnitToMetres = lengthUnitToMetres(horizontalNode);
  // A horizontal-only WKT says nothing about a separate height datum/unit.
  // Do not promote its projected unit into vertical metadata by assumption.
  const verticalUnitToMetres = lengthUnitToMetres(verticalNode);
  return {
    ...(horizontal ? { horizontalId: horizontal } : {}),
    ...(vertical ? { verticalId: vertical } : {}),
    ...(axes ? { axes } : {}),
    ...(horizontalUnitToMetres ? { horizontalUnitToMetres } : {}),
    ...(verticalUnitToMetres ? { verticalUnitToMetres } : {}),
  };
}

/** Backwards-compatible identifier-only view of {@link extractWktSpatialMetadata}. */
export function extractWktCrsIdentifiers(wkt: string): WktCrsIdentifiers {
  const { horizontalId, verticalId } = extractWktSpatialMetadata(wkt);
  return {
    ...(horizontalId ? { horizontalId } : {}),
    ...(verticalId ? { verticalId } : {}),
  };
}
