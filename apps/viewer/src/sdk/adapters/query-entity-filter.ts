/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isQueryableObjectType } from '@ifc-lite/parser';

/** The same object-type oracle the CLI and MCP backends use: every
 * `IfcObjectDefinition` subclass that is not a type object, so a no-type
 * `query.entities()` scan does not drop classes outside the render enum
 * (IfcTendonAnchor, IfcFastener, IfcCableCarrierSegment, …). */
export const isProductType = isQueryableObjectType;
