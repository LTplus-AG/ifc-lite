/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileSchemaIdentifier } from '@ifc-lite/data';
import { generateHeader } from '@ifc-lite/parser';
import type { MergeExportOptions } from './merged-exporter.js';
import type { IfcSchemaVersion } from './schema-converter.js';

/**
 * Build the ifc-lite provenance header for a merged export. Merged files have
 * no single source header to round-trip, so we deliberately emit our own
 * rather than picking one model's FILE_DESCRIPTION arbitrarily. `schema` is
 * the target family; it is declared by its file identifier (IFC4X3 as
 * IFC4X3_ADD2, #5351).
 */
export function buildMergedHeader(
  options: MergeExportOptions,
  schema: IfcSchemaVersion,
  modelCount: number,
): string {
  return generateHeader({
    schema: fileSchemaIdentifier(schema),
    description: options.description || `Merged export of ${modelCount} models from ifc-lite`,
    author: options.author || '',
    organization: options.organization || '',
    application: options.application || 'ifc-lite',
    filename: options.filename || 'merged.ifc',
  });
}
