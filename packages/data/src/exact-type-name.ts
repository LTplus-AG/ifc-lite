/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The class an entity's STEP line actually declares — the answer an EXPORT
 * needs, as distinct from the one GROUPING needs.
 *
 * `IfcTypeEnum` coalesces several class names onto one value on purpose:
 * `IfcDoorStandardCase` shares `IfcDoor`, `IfcSlabStandardCase` shares
 * `IfcSlab`, and `IfcDistributionFlowElement` and
 * `IfcDistributionControlElement` both share `IfcDistributionElement`, so the
 * viewer's scope chips render one chip per family rather than one per spelling
 * (`apps/viewer/src/lib/lists/scope-types.test.ts` pins that, and the enum's
 * numeric values are a wire contract `@ifc-lite/cache` pins separately).
 * `IfcWallStandardCase` is not more exact than the rest — it merely happens to
 * hold its own enum value.
 *
 * `EntityTable.getTypeName` resolves through that enum and only falls back to
 * the parsed name when the enum says `Unknown`, so a known-but-coalesced class
 * never reaches the fallback. For a chip label that is right. For an export it
 * is a silent, unrecoverable substitution: the Parquet `Type` column named an
 * `IFCDOORSTANDARDCASE` line `IfcDoor`, disagreeing with `StepExporter`, which
 * re-emits every class verbatim.
 */

import type { EntityTable } from './entity-table.js';
import type { StringTable } from './string-table.js';
import { IfcTypeEnum, IfcTypeEnumToString } from './types.js';

/** A table surface that may or may not implement the exact accessor. */
export type ExactTypeNameSource = Pick<EntityTable, 'getTypeName'> &
  Partial<Pick<EntityTable, 'getExactTypeName'>>;

/**
 * The exact name for one ROW of a built table. Shared by every table builder
 * that keeps its own columns — `entityTableFromColumns` here and the
 * server-hydrated literal in `apps/viewer/src/utils/serverEntityTable.ts` — so
 * the two cannot drift apart on what "exact" means, and so the reasoning
 * above lives beside the code that needs it rather than inside a 400-line
 * module.
 */
export function exactNameOfRow(
  strings: StringTable,
  rawTypeName: Uint32Array,
  typeEnum: Uint16Array,
  rowIndex: number,
): string {
  if (rowIndex < 0) return 'Unknown';
  // `rawTypeName` is zero-filled when the source columns carried none, and
  // string index 0 is '' — so an empty answer means "this table shape never
  // tracked the parsed name", not "the name was empty". Fall through to the
  // enum, which is then all this table knows; `IfcTypeEnumToString` yields
  // the literal 'Unknown' when even that is absent, so the caller never
  // receives ''.
  return strings.get(rawTypeName[rowIndex]) || IfcTypeEnumToString(typeEnum[rowIndex] as IfcTypeEnum);
}

/**
 * The declared class for an entity, with the ONE shared degradation.
 *
 * Every table this repo builds implements `getExactTypeName`: the parser
 * transport and `@ifc-lite/cache`'s reader both construct theirs through
 * `entityTableFromColumns`, and `apps/viewer/src/utils/serverEntityTable.ts`
 * implements it on its own literal. The member is nonetheless OPTIONAL, for
 * two reasons that outlive that list:
 *
 * - `EntityTable` is a published `@ifc-lite/data` type. Requiring a new
 *   method breaks every implementer outside this repo at once, and buys
 *   nothing the fallback below does not already give them.
 * - Requiring it would not actually enforce it here either. The partial
 *   `EntityTable` doubles across the repo's tests reach the type through
 *   `as unknown as EntityTable`, which satisfies the compiler while supplying
 *   no such method at runtime; an optional call is what keeps those honest
 *   instead of throwing.
 *
 * So the degradation lives here, once. Every caller would otherwise pick its
 * own fallback, and two callers picking different ones is how one model
 * exports inconsistently. `getTypeName` is the honest fallback: a table that
 * never tracked the parsed name knows nothing more exact than its enum.
 */
export function exactTypeName(entities: ExactTypeNameSource, expressId: number): string {
  return entities.getExactTypeName?.(expressId) ?? entities.getTypeName(expressId);
}
