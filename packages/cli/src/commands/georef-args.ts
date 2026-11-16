/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flag parsing for `ifc-lite georef`. Strict on purpose: every value flag
 * takes the next token whatever it looks like (so `--rotation -15` works,
 * which the shared `getPositionalArgs` misreads as a flag), and an unknown
 * flag is refused rather than ignored — a typo'd `--easting` must not write
 * a georeferencing without the easting the caller thought they gave.
 */

import { epsgName, type GeoreferencingSetInput, type GeoreferencingUpdateInput } from '@ifc-lite/sdk';

/** Value flag → where it goes. */
const CRS_FLAGS: Record<string, keyof GeoreferencingSetInput['ProjectedCRS']> = {
  '--crs': 'Name',
  '--description': 'Description',
  '--geodetic-datum': 'GeodeticDatum',
  '--vertical-datum': 'VerticalDatum',
  '--map-projection': 'MapProjection',
  '--map-zone': 'MapZone',
  '--map-unit': 'MapUnit',
};

const MC_FLAGS: Record<string, keyof GeoreferencingSetInput['MapConversion']> = {
  '--eastings': 'Eastings',
  '--northings': 'Northings',
  '--height': 'OrthogonalHeight',
  '--orthogonal-height': 'OrthogonalHeight',
  '--x-axis-abscissa': 'XAxisAbscissa',
  '--x-axis-ordinate': 'XAxisOrdinate',
  '--scale': 'Scale',
  '--factor-x': 'FactorX',
  '--factor-y': 'FactorY',
  '--factor-z': 'FactorZ',
};

const OTHER_VALUE_FLAGS = new Set(['--out', '--epsg', '--rotation']);
const BOOLEAN_FLAGS = new Set(['--json', '--replace']);

export interface ParsedGeorefArgs {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

export class GeorefUsageError extends Error {}

/** Split argv; `allowed` limits which flags this subcommand accepts. */
export function parseGeorefArgs(args: string[], allowed: { values: boolean; out: boolean; replace: boolean }): ParsedGeorefArgs {
  const parsed: ParsedGeorefArgs = { positionals: [], values: new Map(), booleans: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      parsed.positionals.push(arg);
      continue;
    }
    const isValue = arg in CRS_FLAGS || arg in MC_FLAGS || OTHER_VALUE_FLAGS.has(arg);
    const permitted = BOOLEAN_FLAGS.has(arg)
      ? arg !== '--replace' || allowed.replace
      : arg === '--out' ? allowed.out : isValue && allowed.values;
    if (!permitted) throw new GeorefUsageError(`Unknown or unsupported option for this subcommand: ${arg}`);
    if (BOOLEAN_FLAGS.has(arg)) {
      parsed.booleans.add(arg);
      continue;
    }
    // A following flag is not a value: `--out --json` is a missing path, not a file named `--json`.
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new GeorefUsageError(`${arg} needs a value`);
    if (parsed.values.has(arg)) throw new GeorefUsageError(`${arg} was given twice`);
    parsed.values.set(arg, args[++i]);
  }
  return parsed;
}

function number(flag: string, raw: string): number {
  // Decimal notation only: `Number()` also takes 0x10, 0b11 and 0o17, which nobody means as a coordinate.
  const n = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) throw new GeorefUsageError(`${flag} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

/** The SDK input the flags describe. Absent flags stay absent: the SDK decides what is missing. */
export function georefInputFromArgs(parsed: ParsedGeorefArgs): GeoreferencingUpdateInput {
  const crs: Record<string, string> = {};
  const mc: Record<string, number> = {};
  for (const [flag, value] of parsed.values) {
    if (flag in CRS_FLAGS) crs[CRS_FLAGS[flag]] = value;
    else if (flag in MC_FLAGS) {
      const key = MC_FLAGS[flag];
      if (mc[key] !== undefined) throw new GeorefUsageError(`OrthogonalHeight was given twice (--height and --orthogonal-height)`);
      mc[key] = number(flag, value);
    }
  }
  const epsg = parsed.values.get('--epsg');
  if (epsg !== undefined) {
    if (crs.Name !== undefined) throw new GeorefUsageError('Give the CRS once: --crs NAME or --epsg CODE, not both');
    crs.Name = epsgName(epsg);
  }
  const input: GeoreferencingUpdateInput = {};
  if (Object.keys(crs).length > 0) input.ProjectedCRS = crs;
  if (Object.keys(mc).length > 0) input.MapConversion = mc;
  const rotation = parsed.values.get('--rotation');
  if (rotation !== undefined) input.rotationDegrees = number('--rotation', rotation);
  return input;
}
