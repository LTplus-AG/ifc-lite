/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcSchemaVersion } from './schema-converter.js';

/**
 * Get human-readable description of what a conversion entails.
 */
export function describeConversion(
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): string {
  if (fromSchema === toSchema) return 'No conversion needed';

  const warnings: string[] = [];

  if (toSchema === 'IFC2X3') {
    warnings.push('Entities not in IFC2X3 will be mapped to IfcBuildingElementProxy');
    warnings.push('Extra attributes (e.g., PredefinedType) will be trimmed');
  }

  if (toSchema === 'IFC5') {
    warnings.push('IFC5 is alpha/incomplete — exported files may not validate against final spec');
  }

  if (fromSchema === 'IFC4X3' && (toSchema === 'IFC4' || toSchema === 'IFC2X3')) {
    warnings.push('IFC4X3 facility types (Bridge, Road, Railway) will be mapped to Building/Storey');
  }

  return warnings.length > 0
    ? `Converting ${fromSchema} → ${toSchema}: ${warnings.join('; ')}`
    : `Converting ${fromSchema} → ${toSchema}`;
}

