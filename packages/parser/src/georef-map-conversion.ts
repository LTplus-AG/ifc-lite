/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads one `IfcMapConversion` (or `IfcMapConversionScaled`) into a
 * `MapConversion`, or refuses it.
 *
 * Split out of `georef-extractor.ts` the same way the transform side lives in
 * `georef-transform.ts`: the refusal rule below is the part most likely to
 * grow — every mandatory component added to a future schema revision is
 * another slot to check — and it does not belong in a file that is already at
 * its module-size budget.
 */

import type { IfcEntity } from './entity-extractor.js';
import type { MapConversion } from './georef-extractor.js';
import { getNumber, getReference, isUnrepresentableNumericValue } from './attribute-helpers.js';

/**
 * Every numeric component of `IfcMapConversion` that `computeTransformMatrix`
 * reads.
 *
 * Slots 2-4 are the mandatory `IfcLengthMeasure` placement components. Slots
 * 5-7 are OPTIONAL in the schema, and their absence is not the problem — an
 * absent attribute is not a numeric literal, so the predicate below is false
 * for it and the conversion is built as before. What they cannot do is be
 * *present and unrepresentable*: `computeTransformMatrix` turns an undefined
 * `scale` into `1.0` and an undefined axis pair into an angle of `0`, so
 * dropping just the overflowing optional field would substitute the schema
 * default for a value the file explicitly stated. That is the same plausible
 * substitution as a `0` easting — an unrotated, unscaled placement is exactly
 * what a normal file looks like — so an overflowing optional component
 * refuses the whole conversion too.
 */
const TRANSFORM_NUMERIC_SLOTS: readonly (readonly [number, string])[] = [
  [2, 'Eastings'],
  [3, 'Northings'],
  [4, 'OrthogonalHeight'],
  [5, 'XAxisAbscissa'],
  [6, 'XAxisOrdinate'],
  [7, 'Scale'],
];

/**
 * Refuse the whole map conversion when a component the transform reads names a
 * number the double range cannot hold, rather than letting `|| 0` put a zero
 * there.
 *
 * `eastings`/`northings`/`orthogonalHeight` are typed `number` and feed
 * `transformMatrix`, the STEP georeferencing writer and the viewer's placement
 * editor, so absence cannot be expressed in the field itself.
 * `GeoreferenceInfo.mapConversion` IS optional, and every consumer already
 * reaches it as `georef.mapConversion?.eastings` — so refusing here reports
 * "this file has no usable georeference", which is true and which a caller can
 * see. A zero easting is a plausible coordinate: it silently places the model
 * at the projection origin, and nothing downstream can tell that apart from a
 * model that really sits there.
 */
export function extractMapConversion(entity: IfcEntity): MapConversion | null {
  for (const [slot, name] of TRANSFORM_NUMERIC_SLOTS) {
    const raw = entity.attributes[slot];
    if (isUnrepresentableNumericValue(raw)) {
      console.warn(
        `[georef-extractor] ${entity.type} #${entity.expressId} ${name} is outside the ` +
        `IEEE-754 double range (${String(raw)}); refusing the map conversion rather than ` +
        `placing the model at a substituted origin.`,
      );
      return null;
    }
  }

  // IfcMapConversion attributes (IFC4):
  // [0] SourceCRS (IfcCoordinateReferenceSystem)
  // [1] TargetCRS (IfcCoordinateReferenceSystem)
  // [2] Eastings (IfcLengthMeasure)
  // [3] Northings (IfcLengthMeasure)
  // [4] OrthogonalHeight (IfcLengthMeasure)
  // [5] XAxisAbscissa (OPTIONAL IfcReal)
  // [6] XAxisOrdinate (OPTIONAL IfcReal)
  // [7] Scale (OPTIONAL IfcReal)
  return {
    id: entity.expressId,
    sourceCRS: getReference(entity.attributes[0]) || 0,
    targetCRS: getReference(entity.attributes[1]) || 0,
    eastings: getNumber(entity.attributes[2]) || 0,
    northings: getNumber(entity.attributes[3]) || 0,
    orthogonalHeight: getNumber(entity.attributes[4]) || 0,
    xAxisAbscissa: getNumber(entity.attributes[5]),
    xAxisOrdinate: getNumber(entity.attributes[6]),
    scale: getNumber(entity.attributes[7]),
  };
}
