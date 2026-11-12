/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the values of an IFC2X3 varying action are drawn (#9668): its
 * `AppliedLoad` and `SubsequentAppliedLoads`, in station order. Internal to
 * `structural-glyphs.ts`.
 *
 * Along an edge the values sit at equal steps from its start to its end. Each
 * value draws at its own station, and each of the usual edge stations takes the
 * value interpolated linearly between its two neighbours, so a triangular load
 * draws as arrows growing along the member.
 * The `VaryingAppliedLoadLocation` aspect is not read: its `IfcPointOnCurve`
 * parameters are basis-curve parameters, and AxisVM writes 0 and 1 for the two
 * ends of edges of any length. Over a face, the first value with anything to
 * draw is drawn over the whole face.
 */

import type { StructuralLoadInfo } from './structural-load-extractor.js';
import type { ItemShape, Vec3 } from './structural-item-geometry.js';
import { EDGE_STATIONS, lerp, shapeCentre, shapeStations } from './structural-glyph-stations.js';

/** One load to draw: at each of `stations`, with its single markers at `at`. */
export interface LoadPart {
  load: StructuralLoadInfo;
  stations: Vec3[];
  at: Vec3;
}

/** `a` and `b` mixed `t` of the way: every numeric component interpolated, a missing one read as zero. */
function mix(a: StructuralLoadInfo, b: StructuralLoadInfo, t: number): StructuralLoadInfo {
  const components: Record<string, number> = {};
  for (const key of new Set([...Object.keys(a.components), ...Object.keys(b.components)])) {
    components[key] = (a.components[key] ?? 0) * (1 - t) + (b.components[key] ?? 0) * t;
  }
  return { ...a, components };
}

/** The parts of a varying action's loads (`loads.length > 1`) on its shape. */
export function varyingParts(shape: ItemShape, loads: readonly StructuralLoadInfo[], drawable: (load: StructuralLoadInfo) => boolean): LoadPart[] {
  if (shape.kind !== 'edge') {
    const load = loads.find(drawable);
    return load ? [{ load, stations: shapeStations(shape), at: shapeCentre(shape) }] : [];
  }
  const steps = loads.length - 1;
  // Every value's own station, plus the usual edge stations between them.
  const knots = loads.map((_, i) => i / steps);
  const stations = [...new Set([...EDGE_STATIONS, ...knots])].sort((x, y) => x - y);
  return stations.map((t) => {
    const i = Math.min(steps - 1, Math.floor(t * steps));
    const at = lerp(shape.start, shape.end, t);
    return { load: mix(loads[i], loads[i + 1], t * steps - i), stations: [at], at };
  });
}
