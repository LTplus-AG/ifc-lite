/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ComposedNode } from './types.js';

/** Canonical EXPRESS names on the wire; consumers map to their own georef types. */
export function extractGeoreference(composed: Map<string, ComposedNode>): {
  IfcProjectedCRS: { Name: string; MapUnit: 'METRE' };
  IfcMapConversion: { Eastings: number; Northings: number; OrthogonalHeight: number;
    XAxisAbscissa: number; XAxisOrdinate: number; Scale: number };
} | undefined {
  let result: ReturnType<typeof extractGeoreference>;
  for (const node of composed.values()) {
    const value = node.attributes.get('ifclite::georeference::v1');
    if (value === undefined) continue;
    const raw = object(value); const crs = object(raw.IfcProjectedCRS); const map = object(raw.IfcMapConversion);
    if (typeof crs.Name !== 'string' || !/^EPSG:\d+$/.test(crs.Name) || crs.MapUnit !== 'METRE') throw new Error('Invalid IFCX projected CRS.');
    const Eastings = number(map.Eastings); const Northings = number(map.Northings);
    const OrthogonalHeight = number(map.OrthogonalHeight); const XAxisAbscissa = number(map.XAxisAbscissa);
    const XAxisOrdinate = number(map.XAxisOrdinate); const Scale = number(map.Scale);
    if (Scale <= 0 || Math.hypot(XAxisAbscissa, XAxisOrdinate) < 1e-12) throw new Error('Invalid IFCX map conversion.');
    const next = { IfcProjectedCRS: { Name: crs.Name, MapUnit: 'METRE' as const },
      IfcMapConversion: { Eastings, Northings, OrthogonalHeight, XAxisAbscissa, XAxisOrdinate, Scale } };
    const previous = result;
    const coordinates = ['Eastings', 'Northings', 'OrthogonalHeight', 'XAxisAbscissa', 'XAxisOrdinate', 'Scale'] as const;
    if (previous && (previous.IfcProjectedCRS.Name !== next.IfcProjectedCRS.Name ||
        coordinates.some(attribute => previous.IfcMapConversion[attribute] !== next.IfcMapConversion[attribute]))) {
      throw new Error('IFCX contains conflicting model georeferences.');
    }
    // Composition can copy the same placement through inheritance (#6824).
    result ??= next;
  }
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid IFCX georeference.');
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid IFCX georeference coordinate.');
  return value;
}
