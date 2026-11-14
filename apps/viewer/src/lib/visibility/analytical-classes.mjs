/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** @param {string} type */
export function isAnalyticalProduct(type) {
  return /^IfcStructural(?:Curve|Surface|Point)(?:Member|Connection)/i.test(type)
    || /^IfcStructural.*(?:Action|Reaction)(?:Varying)?$/i.test(type); // IFC2X3 Linear/PlanarActionVarying
}
