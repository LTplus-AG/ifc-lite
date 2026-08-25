/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lookup tables every `BimBackend` needs, declared once.
 *
 * There are three backends behind one SDK query API — the viewer's
 * `query-adapter`, `@ifc-lite/cli`'s `HeadlessBackend`, and `@ifc-lite/mcp`'s
 * `backend-query` — and each carried its own byte-identical copy of the two
 * tables below. Only the CLI copy had tests, so editing either of the other
 * two changed what `byType()` or `related()` answered on that surface alone,
 * with nothing failing: dropping `IFCSLABELEMENTEDCASE` from the MCP copy left
 * all 272 of its tests green. Three answers to one question is one answer too
 * many, so the tables live here, next to the `entityIndex` whose key shape
 * they are written against.
 */

import { RelationshipType } from '@ifc-lite/data';

/**
 * IFC4 subtype map — parent types to their StandardCase/ElementedCase
 * subtypes. In IFC4 many element types have `*StandardCase` subtypes that the
 * parser stores under the full type name, so `byType('IfcWall')` has to look
 * for `IfcWallStandardCase` as well to answer what the caller meant.
 *
 * Keys and values are UPPERCASE because `entityIndex.byType` is keyed by the
 * raw STEP type name (e.g. `IFCWALLSTANDARDCASE`).
 */
export const IFC_SUBTYPES: Record<string, string[]> = {
  IFCWALL: ['IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE'],
  IFCBEAM: ['IFCBEAMSTANDARDCASE'],
  IFCCOLUMN: ['IFCCOLUMNSTANDARDCASE'],
  IFCDOOR: ['IFCDOORSTANDARDCASE'],
  IFCWINDOW: ['IFCWINDOWSTANDARDCASE'],
  IFCSLAB: ['IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE'],
  IFCMEMBER: ['IFCMEMBERSTANDARDCASE'],
  IFCPLATE: ['IFCPLATESTANDARDCASE'],
  IFCOPENINGELEMENT: ['IFCOPENINGSTANDARDCASE'],
  // Not a `*StandardCase` family, and absent until #3229: IFC4 exporters write
  // furniture as IFCFURNITURE, so `byType('IfcFurnishingElement')` answered
  // with nothing on a model that plainly contained furniture.
  IFCFURNISHINGELEMENT: ['IFCFURNITURE', 'IFCSYSTEMFURNITUREELEMENT'],
};

/**
 * Expand a caller's type list to include the known IFC subtypes, uppercasing
 * PascalCase input (`'IfcWall'`) for the `entityIndex` lookup.
 */
export function expandTypes(types: string[]): string[] {
  const result: string[] = [];
  for (const type of types) {
    const upper = type.toUpperCase();
    result.push(upper);
    const subtypes = IFC_SUBTYPES[upper];
    if (subtypes) {
      for (const sub of subtypes) result.push(sub);
    }
  }
  return result;
}

/**
 * Relationship names the SDK's `related(ref, relType, direction)` accepts,
 * keyed in the PascalCase spelling a caller writes.
 *
 * Deliberately NARROWER than `REL_TYPE_MAP` in `columnar-parser-indexes.ts`,
 * which the parser uses to bucket every relationship it indexes: the SDK
 * surface exposes five of those, and a name outside this map resolves to no
 * edges rather than throwing. Keeping the two maps in one place — rather than
 * three copies of this one and no cross-reference to the other — is what makes
 * that narrowing visible; widening the SDK surface is a deliberate change to
 * this table, not an accident of which backend a caller reached.
 */
export const QUERY_REL_TYPE_MAP: Record<string, RelationshipType> = {
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelDefinesByType: RelationshipType.DefinesByType,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};
