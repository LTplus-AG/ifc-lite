/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Map-projection parameters around proj4's WKT reader (`wkt-parser`): what a
 * WKT2 parameter without a unit means, and whether the reader picked up the
 * parameters a projection method cannot do without.
 */

/** One degree in radians, as EPSG and PROJ write it. */
const DEGREE = 'ANGLEUNIT["degree",0.0174532925199433]';

/**
 * PROJ's reading of a parameter name (`guessUnitForParameter` in
 * `src/iso19111/io.cpp`). Scale comes first because of "Scale factor on
 * pseudo standard parallel".
 */
const SCALE_NAME = /scale|scaling factor/i;
const ANGULAR_NAME = /latitude|longitude|meridian|parallel|azimuth|angle|heading|rotation/i;
const UNIT_NODE = /^(?:ANGLEUNIT|LENGTHUNIT|SCALEUNIT|PARAMETRICUNIT|TIMEUNIT|UNIT)$/i;

interface Node { name: string; bodyStart: number; end: number }

/** The direct child nodes (`KEYWORD[...]`) between `from` and `to`, skipping quoted text. */
function childNodes(text: string, from: number, to: number): Node[] {
  const nodes: Node[] = [];
  let index = from;
  while (index < to) {
    const char = text[index];
    if (char === '"') {
      index = text.indexOf('"', index + 1) + 1 || to;
      continue;
    }
    const keyword = /^[A-Za-z_][A-Za-z0-9_]*\s*\[/.exec(text.slice(index, Math.min(to, index + 64)));
    const startsWord = !/[A-Za-z0-9_]/.test(text[index - 1] ?? '');
    if (!keyword || !startsWord) {
      index += 1;
      continue;
    }
    const bodyStart = index + keyword[0].length;
    let depth = 1;
    let cursor = bodyStart;
    let quoted = false;
    for (; cursor < to && depth > 0; cursor += 1) {
      if (text[cursor] === '"') quoted = !quoted;
      else if (!quoted && text[cursor] === '[') depth += 1;
      else if (!quoted && text[cursor] === ']') depth -= 1;
    }
    if (depth !== 0) break;
    nodes.push({ name: keyword[0].replace(/[\s[]/g, '').toUpperCase(), bodyStart, end: cursor });
    index = cursor;
  }
  return nodes;
}

/**
 * Give every angular map-projection parameter of a WKT2 `CONVERSION` that
 * states no unit an explicit degree.
 *
 * ISO 19162:2019 (OGC 18-010r7) 9.3.4: when a map projection parameter
 * omits its unit, angles are decimal degrees, lengths metres and scale
 * factors unity. PROJ reads it that way. `wkt-parser` instead passes the bare
 * number through, which proj4 then takes as radians: a central meridian of
 * 7.5 becomes 7.5 rad, 69.7 degrees east. Lengths and scale factors already
 * come out right, so only angles get a unit. WKT1 (`PROJECTION`) is left
 * alone: its reader converts degrees itself.
 */
export function withImpliedParameterUnits(wkt: string): string {
  const insertions: number[] = [];
  const visit = (from: number, to: number): void => {
    for (const node of childNodes(wkt, from, to)) {
      if (node.name !== 'CONVERSION') {
        visit(node.bodyStart, node.end - 1);
        continue;
      }
      for (const parameter of childNodes(wkt, node.bodyStart, node.end - 1)) {
        if (parameter.name !== 'PARAMETER') continue;
        const body = wkt.slice(parameter.bodyStart, parameter.end - 1);
        if (childNodes(body, 0, body.length).some((child) => UNIT_NODE.test(child.name))) continue;
        const head = /^\s*"((?:[^"]|"")*)"\s*,\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(body);
        if (!head || SCALE_NAME.test(head[1]) || !ANGULAR_NAME.test(head[1])) continue;
        insertions.push(parameter.bodyStart + head[0].length);
      }
    }
  };
  visit(0, wkt.length);
  let result = wkt;
  for (const position of insertions.reverse()) {
    result = `${result.slice(0, position)},${DEGREE}${result.slice(position)}`;
  }
  return result;
}

/**
 * The proj4 parameters a projection method has no meaningful default for:
 * without them proj4 silently uses 0 (a central meridian of 0 degrees puts
 * the model hundreds of kilometres west) or 1. Keyed by the method name with
 * case, spaces and punctuation removed, in its EPSG, WKT1 and ESRI spellings.
 * A method not listed is not checked.
 */
const REQUIRED_PARAMETERS: readonly [RegExp, readonly string[]][] = [
  [/^(?:transversemercator|gausskruger|tmerc)$/, ['long0', 'k0']],
  [/^(?:obliquestereographic|doublestereographic|sterea)$/, ['long0', 'lat0', 'k0']],
  [/^(?:lambertconicconformal1sp|lambertconformalconic1sp)$/, ['long0', 'lat0', 'k0']],
  [/^(?:lambertconicconformal2sp|lambertconformalconic2sp)$/, ['long0', 'lat1', 'lat2']],
  // Without a 1SP/2SP suffix a WKT may state one parallel or two.
  [/^(?:lambertconformalconic|lcc)$/, ['long0', 'lat1']],
  [/^(?:mercator|mercator1sp|mercator2sp|mercatorvarianta|mercatorvariantb)$/, ['long0']],
];

/** What `wkt-parser` returns, as far as this check reads it. */
export interface ParsedProjection {
  projName?: string;
  [key: string]: unknown;
}

/**
 * The parameters `parsed` lacks for its projection method; empty when it has
 * them all or the method is not checked. A WKT whose parameter names the
 * reader did not recognise ends up here instead of at the wrong place.
 */
export function missingProjectionParameters(parsed: ParsedProjection): string[] {
  const method = (parsed.projName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const required = REQUIRED_PARAMETERS.find(([pattern]) => pattern.test(method))?.[1] ?? [];
  return required.filter((key) => typeof parsed[key] !== 'number' || !Number.isFinite(parsed[key]));
}
