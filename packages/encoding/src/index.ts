/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { decodeIfcString, encodeIfcString } from './ifc-string.js';
export {
  uuidToIfcGuid,
  ifcGuidToUuid,
  generateIfcGuid,
  generateUuid,
  isValidIfcGuid,
  isValidUuid,
} from './guid.js';
export type { RandomSource } from './guid.js';
export { parsePropertyValue } from './property-value.js';
export type { ParsedPropertyValue } from './property-value.js';
