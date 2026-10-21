// SPDX-License-Identifier: MPL-2.0
// #8019: audited IFC4/IFC4X3 IfcDistributionElement occurrence descendants
// absent from IFC2X3, grouped by their nearest native IFC2X3 ancestor.
// Preserve the existing distribution-board -> distribution-point semantic
// rename (including IFC4X3's board). Type objects are deliberately excluded.
// Explicit scope: never apply an ancestor fallback to arbitrary unknown types.
import mep from './schema-converter-mep.json' with { type: 'json' };

export const MEP_IFC2X3_TYPES: ReadonlyMap<string, string> = new Map(
  Object.entries(mep.types).flatMap(([target, sources]) => sources.map((source): [string, string] => [source, target])),
);
