/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProjectUnits } from '@ifc-lite/parser';
import { formatConverted, resolveMeasureDisplay, resolveQuantityDisplay } from '@/lib/units/display';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { parsePropertyValue, type PropertySet, type QuantitySet } from './encodingUtils';

/** One display contract for cards and the find filter; search must see the same converted text. */
export function propertyDisplayValue(property: PropertySet['properties'][number], units: ProjectUnits, overrides: Record<string, string>) {
  const parsed = parsePropertyValue(property.value);
  const display = resolveMeasureDisplay(property.value, property.dataType, units, overrides);
  const value = display.converted !== null ? formatConverted(display.converted) : parsed.displayValue;
  const unit = display.unit && parsed.displayValue !== '\u2014' ? display.unit : null;
  return { parsed, value, unit, full: unit ? `${value} ${unit}` : value };
}

export function quantityDisplayValue(quantity: QuantitySet['quantities'][number], units: ProjectUnits, overrides: Record<string, string>, locale: string): string {
  if (isNaN(quantity.value)) return '\u2014';
  const display = resolveQuantityDisplay(quantity.value, quantity.type, units, overrides);
  const value = formatLocaleNumber(locale, display.converted ?? quantity.value, {
    maximumFractionDigits: display.converted !== null ? 4 : 3,
  });
  return display.unit ? `${value} ${display.unit}` : value;
}
