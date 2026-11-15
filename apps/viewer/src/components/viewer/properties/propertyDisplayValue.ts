/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProjectUnits } from '@ifc-lite/parser';
import { formatMeasureNumber, resolveMeasureDisplay, resolveQuantityDisplay } from '@/lib/units/display';
import { parsePropertyValue, type PropertySet, type QuantitySet } from './encodingUtils';

/** One display contract for cards and the find filter; search must see the same converted text. */
export function propertyDisplayValue(property: PropertySet['properties'][number], units: ProjectUnits, overrides: Record<string, string>, projectUnitsAvailable = true, locale = 'en') {
  const parsed = parsePropertyValue(property.value);
  const display = resolveMeasureDisplay(property.value, property.dataType, units, overrides, projectUnitsAvailable);
  // A number with a unit prints by the one measure rule whether or not it was converted (#9950); text,
  // booleans and unit-less numbers keep their parsed display.
  const measured = display.converted ?? (display.unit && typeof property.value === 'number' && Number.isFinite(property.value) ? property.value : null);
  const value = measured !== null ? formatMeasureNumber(locale, measured) : parsed.displayValue;
  const unit = display.unit && parsed.displayValue !== '\u2014' ? display.unit : null;
  return { parsed, value, unit, full: unit ? `${value} ${unit}` : value };
}

export function quantityDisplayValue(quantity: QuantitySet['quantities'][number], units: ProjectUnits, overrides: Record<string, string>, locale: string, projectUnitsAvailable = true): string {
  if (isNaN(quantity.value)) return '\u2014';
  const display = resolveQuantityDisplay(quantity.value, quantity.type, units, overrides, quantity, projectUnitsAvailable);
  const value = formatMeasureNumber(locale, display.converted ?? quantity.value);
  return display.unit ? `${value} ${display.unit}` : value;
}
