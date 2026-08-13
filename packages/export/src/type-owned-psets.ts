/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An `IfcTypeObject` owns its property sets through `HasPropertySets`, not
 * through an `IfcRelDefinesByProperties` — that relationship is how an
 * OCCURRENCE is defined. Getting the distinction wrong does not lose data, it
 * produces structurally wrong IFC that a schema-checking consumer rejects.
 *
 * Which side of the distinction an entity falls on is decided by its EFFECTIVE
 * class (see `effective-index.ts`): `StepExporter` used to read the source
 * record's class, so a type object the session had just created looked like an
 * occurrence and its psets went out on a relation (#2012).
 */

import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { replaceStepArgument } from './step-argument-parser.js';

/** `HasPropertySets` is slot 5 on every `IfcTypeObject` subtype, all schemas. */
export const HAS_PROPERTY_SETS_SLOT = 5;

/** class name → is it an `IfcTypeObject`. A property of the class, asked once
 *  per affected entity, so it is worth remembering. */
const typeObjectByClass = new Map<string, boolean>();

/**
 * Is this the class of an IFC type object (`IfcWallType`, `IfcDoorStyle` …)?
 *
 * **From the cross-schema inheritance chain, never from the name**, the same way
 * #2033 decides it and for the same reason: IFC2X3's `IfcDoorStyle` and
 * `IfcWindowStyle` are `IfcTypeProduct` subtypes that carry `HasPropertySets` at
 * slot 5 and do not end in `Type`. A `TYPE` suffix test called them occurrences
 * and routed their psets onto an `IfcRelDefinesByProperties` — precisely the
 * misclassification this module exists to prevent, on a class of file that is
 * still most of what is in the wild. The Duplex fixture has six of each; it is
 * not committed, so fetch it with `pnpm fixtures` (checksummed in
 * `tests/models/manifest.json`) and count for yourself — the
 * `overlay-effective-model.test.ts` case that reads it skips when it is absent.
 *
 * The suffix test was also too WIDE in the other direction:
 * `IfcRelDefinesByType` ends in `TYPE` and is a relationship, so a property edit
 * on one would have been written into its slot 5.
 *
 * A class no bundled schema declares has no chain to judge and is treated as an
 * occurrence. That is the safe direction: an `IfcRelDefinesByProperties` is
 * structurally valid for anything, whereas writing into slot 5 of a class we
 * cannot confirm has `HasPropertySets` there would be a guess that corrupts the
 * record. It is the same call `diff-scope.ts` makes about an unrecognised class,
 * and it costs a vendor type object its type-owned routing.
 *
 * Takes the class rather than an entity id, so a caller cannot accidentally
 * answer it from the source buffer when the overlay owns the record.
 */
export function isTypeClass(typeUpper: string | undefined): boolean {
  if (typeUpper === undefined) return false;
  const cached = typeObjectByClass.get(typeUpper);
  if (cached !== undefined) return cached;
  const isTypeObject = getInheritanceChainAcrossSchemas(typeUpper).includes('IfcTypeObject');
  typeObjectByClass.set(typeUpper, isTypeObject);
  return isTypeObject;
}

/**
 * The `HasPropertySets` list a type object should carry after export: the psets
 * it already had, with each affected one swapped for the replacement this export
 * generated, plus any replacement the original list did not name.
 *
 * An affected pset with no replacement is a deletion, and simply drops out.
 *
 * @param nameOf resolves a pset id to its Name, or null when it is not a source
 *   record this exporter can read (an overlay-created pset, say) — such an id is
 *   never "affected" and is carried through untouched.
 */
export function resolveTypeOwnedPsetIds(
  originalPsetIds: readonly number[],
  affectedPsetNames: ReadonlySet<string>,
  replacementPsetIds: ReadonlyMap<string, number>,
  nameOf: (psetId: number) => string | null,
): number[] {
  const resolved: number[] = [];
  const usedReplacementNames = new Set<string>();

  for (const psetId of originalPsetIds) {
    const psetName = nameOf(psetId);
    if (psetName && affectedPsetNames.has(psetName)) {
      const replacementId = replacementPsetIds.get(psetName);
      if (replacementId !== undefined) {
        resolved.push(replacementId);
        usedReplacementNames.add(psetName);
      }
      continue;
    }
    resolved.push(psetId);
  }

  for (const [psetName, psetId] of replacementPsetIds) {
    if (!usedReplacementNames.has(psetName)) {
      resolved.push(psetId);
    }
  }

  return resolved;
}

/** The STEP token for a resolved `HasPropertySets` list (`$` when empty). */
export function hasPropertySetsToken(ids: readonly number[]): string {
  return ids.length > 0 ? `(${ids.map((id) => `#${id}`).join(',')})` : '$';
}

/** What the type-object rewrite produced for one entity. */
export interface TypeOwnedPsetRewrite {
  /**
   * The line to emit for the type object. NEVER null when there was a line to
   * start with: the rewrite pass owns this entity's only defining line, so
   * "could not repoint" must not become "not in the file".
   */
  line: string;
  /** Did `HasPropertySets` actually get repointed? */
  repointed: boolean;
}

/**
 * Repoint a type object's `HasPropertySets`, keeping the line either way.
 *
 * The caller has already made the source-iteration pass skip this entity
 * (`rewrittenEntityIds`), on the promise that this pass writes its replacement.
 * `replaceStepArgument` returns null for a record it cannot parse as
 * `#id=TYPE(...);` with at least six arguments — not a schema question (every
 * `IfcTypeObject` subtype declares `HasPropertySets` at slot 5) but an INPUT
 * one: a truncated or hand-mangled line in the file being exported. Returning
 * null to the caller made it emit nothing, and the entity then vanished from
 * the output entirely — not a wrong attribute, the whole record, in silence.
 *
 * So a failed replacement falls back to the line the mutation pipeline
 * produced, which is byte-for-byte what the source-iteration pass would have
 * written for this entity had it not been told to skip it. The property-set
 * change is lost — it has nowhere to go on a line without the slot — and
 * {@link typeOwnedPsetRewriteWarning} is how the caller says so out loud.
 */
export function rewriteTypeOwnedPsetLine(
  mutatedLine: string,
  resolvedPsetIds: readonly number[],
): TypeOwnedPsetRewrite {
  const rewritten = replaceStepArgument(
    mutatedLine,
    HAS_PROPERTY_SETS_SLOT,
    hasPropertySetsToken(resolvedPsetIds),
  );
  return rewritten !== null
    ? { line: rewritten, repointed: true }
    : { line: mutatedLine, repointed: false };
}

/**
 * Why a type object's property-set change could not be written, in the words a
 * consumer of `stats.warnings` needs: what was lost, what was kept, and that
 * neither is a transient failure they can retry away.
 */
export function typeOwnedPsetRewriteWarning(
  entityId: number,
  reason: 'unparseable-line' | 'no-source-bytes',
): string {
  if (reason === 'no-source-bytes') {
    return (
      `Type object #${entityId}: no source bytes were available to rewrite, so its `
      + 'property-set change was not applied and no line was written for it.'
    );
  }
  return (
    `Type object #${entityId}: its source line does not parse as a STEP record with a `
    + `HasPropertySets slot (slot ${HAS_PROPERTY_SETS_SLOT}), so its property-set change was `
    + 'not applied. The line was kept as it stands, carrying the session\'s other edits, rather '
    + 'than dropped — but any replacement property set this export generated for it is '
    + 'unreferenced. Repair the record in the source file and export again.'
  );
}
