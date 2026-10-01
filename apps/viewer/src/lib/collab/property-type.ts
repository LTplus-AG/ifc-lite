/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PropertyValueType } from '@ifc-lite/data';
import { validatePropertyDataType } from '@ifc-lite/export';
/** Map a collab IFC type string back to the closest `PropertyValueType`. */
export function propertyValueTypeFor(ifcType: string): PropertyValueType {
  switch (ifcType) {
    case 'IfcBoolean':
    case 'IfcLogical':
      return PropertyValueType.Boolean;
    case 'IfcInteger':
      return PropertyValueType.Integer;
    case 'IfcReal':
      return PropertyValueType.Real;
    case 'IfcIdentifier':
      return PropertyValueType.Identifier;
    case 'IfcText':
      return PropertyValueType.Text;
    default:
      try { return validatePropertyDataType(null, ifcType).valueType; }
      catch { console.warn('Unsupported collab property type; using the label fallback'); return PropertyValueType.Label; }
  }
}

