/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFCX has no unit assignment: no IfcProject.UnitsInContext, no node that names a length unit (hello-wall.ifcx
 * imports the ifc, prop, ifc-mat, usd and nlsfb schemas and none declares one). This reader takes every coordinate
 * and quantity as authored (`extractGeometry` applies no scale), so it treats IFCX lengths as metres.
 *
 * THAT IS AN ASSUMPTION, set here and nowhere else: no buildingSMART IFC5 document reachable from this repository
 * states the unit (the IFC5-development examples README does not), so it is not cited. It is stated once, as the
 * factor the IFC reader hands over for a metre-declaring file (1), so that consumers get the assumption from the
 * parse result instead of each one finding no IfcProject and warning. It is still an assumption, not a declaration:
 * the parser reports it as `source: 'default'`.
 */
export const IFCX_LENGTH_UNIT_SCALE = 1;
