/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE source-buffer attribute-mutation pipeline: retype, then named
 * attribute edits, then positional edits, applied to a line read out of the
 * STEP source. Both {@link applySourceLineMutations}'s call sites — the
 * source-iteration pass and the type-object `HasPropertySets` rewrite that
 * REPLACES it — are documented on the function itself.
 *
 * This file used to also hold the overlay-created sibling pipeline and the
 * two per-slot serialize helpers both pipelines share; #3184 split those out
 * along the line this module's own doc already drew — the overlay-created
 * pipeline is now `step-overlay-attribute-overrides.ts`, and the shared
 * serializers are `step-attribute-serializers.ts`.
 */

import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { getRealTypedSlots } from './attribute-real-slots.js';
import { retypeStepLine } from './retype.js';
import { attrIndex, stepSourceSchema } from './subset-entity-reader.js';
import type { IfcAttributeValue } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcSchemaVersion } from './schema-converter.js';
import { serializeNamedAttribute, serializePositionalOverride } from './step-attribute-serializers.js';
import { unreadableRecordEditsDroppedWarning } from './step-export-types.js';
import type { SourceLineMutations } from './step-exporter.js';

/**
 * THE mutation pipeline for a line read out of the source buffer: retype,
 * then named attribute edits, then positional edits.
 *
 * **One implementation, two call sites**, and that is the whole point. Two
 * passes can write the defining line of a source entity — the
 * source-iteration pass, and the type-object `HasPropertySets` rewrite that
 * REPLACES it (`rewrittenEntityIds` makes the source pass skip those ids).
 * The rewrite used to do its own thing (replace slot 5, nothing else), so
 * every other edit to a type object with a type-owned pset edit was dropped
 * in silence: first the renames (#2462 follow-up), and after those were
 * special-cased here, still the retypes and the positional edits. Whatever
 * the source pass applies, the rewrite has to apply too, or the next edit
 * kind added to one site goes missing at the other.
 *
 * The order is load-bearing:
 *
 *   - the retype runs FIRST so named attribute edits resolve against the
 *     TARGET class's attribute names, and so positional slots are indexed
 *     into the retyped argument list;
 *   - the `HasPropertySets` replacement (rewrite path only) runs LAST, on
 *     the text this returns. Run it first and a positional edit to slot 5 —
 *     or a retype's argument-list rebuild — overwrites the resolved pset
 *     list with the stale one, which is the same silent drop one slot over.
 *
 * The expressId is unchanged by all of this, so geometry / placement /
 * representation and every IfcRel* reference (keyed by #id) carry over.
 *
 * The three delivery flags report EFFECT, not intent — each is the answer to
 * "did this operation change the line", measured across that operation alone. The count
 * and the ledger are claims about the FILE, so an edit that resolves to the
 * text already there has delivered nothing and must not be reported: retyping
 * an entity to the class it already is, or writing a positional slot the token
 * it already holds, used to count as a modification and reach the ledger as a
 * landed edit, over a byte-identical line. Discarded edits read the same way:
 * `applyAttributeMutations` drops a name its class has no slot for and
 * `retypeStepLine` returns an unparseable line untouched, and neither is a
 * modification of anything.
 *
 * `retyped` / `positional` matter most in a FULL export, which is where the
 * two are nominated (their edits have no earlier nomination site); named
 * attribute edits are nominated by the collection pass and `attributed` only
 * settles their delivery.
 *
 * `unreadable` is the fourth field and answers a different question: not what
 * this line carries, but whether the pipeline could read it at all. Every edit
 * kind above writes a slot BY INDEX, so all of them refuse together on a record
 * whose argument list does not scan — and three false delivery flags cannot say
 * that, because a discarded edit sets them too. Both call sites turn it into a
 * warning naming the entity (#4125).
 */
export function applySourceLineMutations(
  mutationView: MutablePropertyView | null,
  expressId: number,
  entityText: string,
  recordType: string,
  attributeMutations: Map<string, string> | undefined,
  sourceSchema: IfcSchemaVersion,
  overlayActive: boolean,
  onRejected?: (attrName: string, value: string) => void,
): SourceLineMutations {
  let text = entityText;
  let workingType = recordType.toUpperCase();

  const typeMutation = overlayActive && typeof mutationView!.getEntityTypeMutation === 'function'
    ? mutationView!.getEntityTypeMutation(expressId)
    : null;
  let retyped = false;
  if (typeMutation) {
    const beforeRetype = text;
    text = retypeStepLine(
      text,
      recordType,
      typeMutation.newType,
      typeMutation.predefinedType ?? null,
      sourceSchema,
    );
    retyped = text !== beforeRetype;
    // Set even for a no-op retype: the entity IS the target class from here
    // on, so the named and positional edits below must resolve against it.
    workingType = typeMutation.newType.toUpperCase();
  }

  // `applyAttributeMutations` returns its input UNCHANGED when it wrote
  // nothing — no slot resolved for any of the names, or the line does not
  // parse — so comparing is what tells the ledger whether a named attribute
  // edit was really carried, rather than merely attempted.
  let attributed = false;
  if (attributeMutations && attributeMutations.size > 0) {
    const beforeAttributes = text;
    text = applyAttributeMutations(
      text,
      workingType,
      attributeMutations,
      sourceSchema,
      onRejected,
    );
    attributed = text !== beforeAttributes;
  }

  const positionals = overlayActive && typeof mutationView!.getPositionalMutationsForEntity === 'function'
    ? mutationView!.getPositionalMutationsForEntity(expressId)
    : null;
  let positional = false;
  if (positionals && positionals.size > 0) {
    const beforePositionals = text;
    text = applyPositionalMutations(text, positionals, workingType, sourceSchema);
    positional = text !== beforePositionals;
  }

  // All three edit kinds above address this line's arguments BY INDEX, so all
  // three refuse together when the argument list does not scan into slots —
  // and all three then look exactly like an edit that resolved to the text
  // already there. That is the failure this whole family is about, so the
  // refusal is stated rather than left to be inferred from three false flags
  // (#4125). Only ever set when an edit was actually asked for: a malformed
  // record nobody edited has refused nothing.
  //
  // The three delivery flags are tested FIRST because any one of them being
  // true already answers the question, without splitting the record a second
  // time. Each of `retypeStepLine`, `applyAttributeMutations` and
  // `applyPositionalMutations` returns its input UNCHANGED when it refuses, so
  // a flag that is true means that writer replaced a slot, which means it
  // scanned the argument list — over the same substring, between the same
  // `indexOf('(')` and `lastIndexOf(');')` bounds `argumentListScans` uses. So
  // the added conjuncts only ever skip a call that would have returned true;
  // they cannot turn a refusal into a readable record.
  const requested = typeMutation !== null
    || (attributeMutations?.size ?? 0) > 0
    || (positionals?.size ?? 0) > 0;
  const unreadable = requested
    && !attributed
    && !retyped
    && !positional
    && !argumentListScans(entityText);

  return { text, attributed, retyped, positional, unreadable };
}

/**
 * The pipeline as a writing pass is handed it: {@link applySourceLineMutations}
 * with the export's `MutablePropertyView` already bound
 * (`step-export-contexts.ts`). Derived from the function rather than restated,
 * so the injected form cannot drift from the real one.
 */
type BoundSourceLineMutations = (
  ...args: WithoutView<Parameters<typeof applySourceLineMutations>>
) => SourceLineMutations;
type WithoutView<T extends unknown[]> = T extends [MutablePropertyView | null, ...infer Rest]
  ? Rest
  : never;

/**
 * Run the pipeline for a writing pass and report BOTH ways it can decline to
 * write, into that pass's warnings.
 *
 * Two passes emit a source entity's defining line — the source-iteration pass
 * and the type-object `HasPropertySets` rewrite that REPLACES it — and each
 * needs the same pair: the per-attribute rejection (a REAL-typed slot handed a
 * non-number) and the whole-record refusal ({@link SourceLineMutations.unreadable}).
 * They were two identical blocks at the two call sites, which is one block per
 * pass too many: a third pass copying one of them gets a report that is right
 * about one channel and silent about the other, and silence is what #4125 is
 * about. So the call and both reports are one thing here.
 */
export function applySourceLineMutationsReported(
  apply: BoundSourceLineMutations,
  warnings: string[],
  expressId: number,
  entityText: string,
  recordType: string,
  attributeMutations: Map<string, string> | undefined,
  sourceSchema: IfcSchemaVersion,
  overlayActive: boolean,
): SourceLineMutations {
  const mutated = apply(
    expressId,
    entityText,
    recordType,
    attributeMutations,
    sourceSchema,
    overlayActive,
    (attr, value) =>
      warnings.push(
        `entity #${expressId}: attribute ${attr} not written - ` +
          `${JSON.stringify(value)} is not a number and the slot is REAL-typed`,
      ),
  );
  if (mutated.unreadable) {
    warnings.push(unreadableRecordEditsDroppedWarning(expressId, recordType));
  }
  return mutated;
}

/**
 * Does this line's own argument list scan into slots?
 *
 * Scoped to the arguments deliberately. Text that is not a `#N=CLASS(...);`
 * record at all is a different fact, and one every writer here already returns
 * untouched without claiming anything; this answers only the question the
 * by-index writers below actually ask.
 */
function argumentListScans(entityText: string): boolean {
  const openParen = entityText.indexOf('(');
  const closeParen = entityText.lastIndexOf(');');
  if (openParen < 0 || closeParen < openParen) return true;
  return splitTopLevelStepArguments(entityText.slice(openParen + 1, closeParen)) !== null;
}

/**
 * Rewrite root IFC attributes directly on the original STEP entity line.
 */
function applyAttributeMutations(
  entityText: string,
  entityType: string,
  attributeMutations: Map<string, string>,
  schemaVersion: IfcSchemaVersion,
  onRejected?: (attrName: string, value: string) => void,
): string {
  const openParen = entityText.indexOf('(');
  const closeParen = entityText.lastIndexOf(');');
  if (openParen < 0 || closeParen < openParen) {
    return entityText;
  }

  // Validating, not permissive. Every write below is BY INDEX into these
  // parts, so parts that are not the record's slots put the value on another
  // attribute and delete whatever was there, while `changed` still says the
  // edit landed (#2470, #4125). A `null` refuses the whole line's named edits
  // rather than handing back a success that did not happen; the caller reports
  // it (see {@link applySourceLineMutations}).
  const args = splitTopLevelStepArguments(entityText.slice(openParen + 1, closeParen));
  if (args === null) return entityText;
  // A source line NEVER pads (unlike the overlay-created path): a short
  // argument list here means the file speaks a different schema, and growing
  // a record we did not author would corrupt it.
  let changed = false;
  const realSlots = getRealTypedSlots(entityType, schemaVersion);

  // Resolve each name against THIS record's own schema first (`attrIndex`,
  // `subset-entity-reader.ts`) — the bundled schemas do not always agree on a
  // class's attribute order (IFC2X3's `IfcTask.Status` sits at slot 6; IFC4
  // inserts `Identification`/`LongDescription` ahead of it, pushing `Status`
  // to slot 7). Resolving against a fixed IFC4-pinned order regardless of
  // `schemaVersion` writes the new value into a DIFFERENT, unrelated
  // attribute of the true record: silent corruption, not a dropped edit —
  // exactly the write-side pitfall `attrIndex`'s own doc comment warned this
  // function used to fall into (fixed here). Falls back to the pinned-first
  // cross-schema union (via `attrIndex`'s own fallback) only when the source
  // schema's own table doesn't know the type at all.
  const sourceSchema = stepSourceSchema(schemaVersion);
  for (const [attrName, value] of attributeMutations) {
    const index = attrIndex(entityType, attrName, sourceSchema);
    if (index < 0 || index >= args.length) continue;
    // The source path shares every `$`-slot hole with the overlay-created
    // path, because a source record has plenty of `$` slots of its own. Both
    // go through the one helper below.
    const serialized = serializeNamedAttribute(
      entityType,
      index,
      value,
      args[index],
      realSlots,
    );
    if (serialized === null) {
      // Slot untouched AND reported. Not counted as a change: claiming a
      // modification we did not make is the failure this avoids.
      onRejected?.(attrName, value);
      continue;
    }
    args[index] = serialized;
    changed = true;
  }

  if (!changed) {
    return entityText;
  }

  return `${entityText.slice(0, openParen + 1)}${args.join(',')}${entityText.slice(closeParen)}`;
}

/**
 * Apply positional STEP argument overrides to an entity line.
 * Used for non-IfcRoot edits (e.g. profile dimensions) where attributes
 * have no symbolic names. Indexes that fall outside the existing arg list
 * are silently ignored.
 */
function applyPositionalMutations(
  entityText: string,
  positionals: Map<number, IfcAttributeValue>,
  entityType: string,
  schemaVersion: IfcSchemaVersion,
): string {
  const openParen = entityText.indexOf('(');
  const closeParen = entityText.lastIndexOf(');');
  if (openParen < 0 || closeParen < openParen) return entityText;

  // Validating for the same reason as the named path above: `args[index] = …`
  // is only an edit to attribute `index` when the parts ARE the record's slots.
  const args = splitTopLevelStepArguments(entityText.slice(openParen + 1, closeParen));
  if (args === null) return entityText;
  const realSlots = getRealTypedSlots(entityType, schemaVersion);
  let changed = false;
  for (const [index, value] of positionals) {
    if (index < 0 || index >= args.length) continue;
    args[index] = serializePositionalOverride(entityType, index, value, args[index], realSlots, schemaVersion);
    changed = true;
  }
  if (!changed) return entityText;
  return `${entityText.slice(0, openParen + 1)}${args.join(',')}${entityText.slice(closeParen)}`;
}
