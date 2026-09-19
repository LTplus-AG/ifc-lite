/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcTypeEnum, IfcTypeEnumFromString } from '@ifc-lite/data';

export function isProductType(type: string): boolean {
  if (IfcTypeEnumFromString(type) === IfcTypeEnum.Unknown) return false;
  const upper = type.toUpperCase();
  return !upper.startsWith('IFCREL')
    && !upper.startsWith('IFCPROPERTY')
    && !upper.startsWith('IFCQUANTITY')
    && upper !== 'IFCELEMENTQUANTITY'
    && !upper.endsWith('TYPE');
}
