/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcSchemaVersion } from '@ifc-lite/data';

/**
 * Narrow a parser schema-version string to the subset
 * `@ifc-lite/data` carries lookup tables for. The parser surfaces a
 * wider union (`'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5'`) than the
 * schema package supports; IFC5 has no published EXPRESS schema yet so
 * we treat it as IFC4X3 for type lookups.
 */
export function narrowSchemaVersion(raw: string | undefined): IfcSchemaVersion {
  switch ((raw || '').toUpperCase()) {
    case 'IFC2X3':
      return 'IFC2X3';
    case 'IFC4':
      return 'IFC4';
    case 'IFC4X3':
    case 'IFC4X3_ADD2':
    case 'IFC5':
      return 'IFC4X3';
    default:
      return 'IFC4';
  }
}
