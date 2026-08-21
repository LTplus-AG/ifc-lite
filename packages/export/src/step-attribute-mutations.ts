/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The attribute-mutation serialization cluster StepExporter's private
 * helpers used to be (#2475, remaining private helpers). One pipeline,
 * `applySourceLineMutations`, and the overlay-created sibling that shares its
 * two serialize helpers, `applyOverlayEntityOverrides` — both were already
 * class-bound closures injected into `SourceIterationContext`,
 * `PropertySetContext` and `OverlayEntitiesContext` rather than called
 * directly from `export()`, so moving them out from under `StepExporter`
 * changes nothing any of those three contexts see.
 *
 * `applyAttributeMutations`, `serializeNamedAttribute`,
 * `applyPositionalMutations` and `serializePositionalOverride` are pure —
 * no `this` in their bodies — and have no reader outside this cluster, so
 * they move as ordinary module-private functions. Only
 * `applySourceLineMutations` touched `this`, and only for
 * `this.mutationView`'s two optional methods
 * (`getEntityTypeMutation` / `getPositionalMutationsForEntity`); it now
 * takes the mutation view as its first parameter instead.
 */

import type { IfcAttributeValue } from '@ifc-lite/parser';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcSchemaVersion } from './schema-converter.js';
import { retypeStepLine } from './retype.js';
import { splitTopLevelArgs } from './step-argument-parser.js';
import { getRealTypedSlots, isTypedMarker } from './attribute-real-slots.js';
import {
  getEnumTypedSlots,
  getStringTypedSlots,
  serializeEnumToken,
  serializeStringSlot,
} from './attribute-slot-types.js';
import { serializeQualifiedSelectSlot } from './select-qualification.js';
import {
  toStepReal,
  serializeAttributeValue,
  serializeStepValue,
  tokenIsRealLiteral,
} from './step-serialization.js';
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
 * All three flags report EFFECT, not intent — each is the answer to "did this
 * operation change the line", measured across that operation alone. The count
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

  return { text, attributed, retyped, positional };
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

  // Cross-schema, not the IFC4 pin: an IFC4X3-only class (IfcCourse, IfcRoad,
  // IfcBridge, …) resolves no slots under the pin, so every named edit on one
  // was silently discarded here too. Identical for the 755 pinned classes
  // that declare attributes — `attribute-slot-types.test.ts` measures that —
  // so no IFC4 export changes; this only stops dropping edits it used to drop.
  const attrNames = getAttributeNamesAcrossSchemas(entityType);
  if (attrNames.length === 0) {
    return entityText;
  }

  const args = splitTopLevelArgs(entityText.slice(openParen + 1, closeParen));
  // A source line NEVER pads (unlike the overlay-created path): a short
  // argument list here means the file speaks a different schema, and growing
  // a record we did not author would corrupt it.
  let changed = false;
  const realSlots = getRealTypedSlots(entityType, schemaVersion);

  for (const [attrName, value] of attributeMutations) {
    const index = attrNames.indexOf(attrName);
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
 * Serialize one NAMED attribute override into its slot — the single point
 * both the source-buffer rewrite and the overlay-created rewrite go through.
 *
 * `serializeAttributeValue` decides the STEP form by reading the token being
 * replaced, which is sound only while that token carries type information. A
 * `$` slot carries none, and both paths have plenty: a source record's
 * optional attributes are `$`, and overlay-created records pad missing slots
 * with `$`. So the declared type decides first, and inference is the fallback
 * for slots the schema does not classify (references, SELECTs, numerics),
 * where reading the old token is exactly the right heuristic.
 *
 * Before this REAL check existed, "the declared type decides first" was true
 * for enum/string slots only — a REAL-backed slot (`IfcMapConversion.
 * OrthogonalHeight`, any other `IfcLengthMeasure`/`IfcReal`-typed attribute)
 * fell straight to `serializeAttributeValue`'s token inference, which quotes
 * anything it cannot recognize as numeric. A schema-legal `$` placeholder
 * carries no digits to recognize, so setting such a field for the first time
 * wrote `'12345'` in a slot ISO 10303-21 requires to be an unquoted REAL —
 * silently invalid output (#2724, LTplus-AG/ifc-lite#2475).
 */
function serializeNamedAttribute(
  entityType: string,
  index: number,
  value: string,
  currentToken: string,
  realSlots: ReadonlySet<number>,
): string | null {
  if (getEnumTypedSlots(entityType).has(index)) return serializeEnumToken(value);
  if (getStringTypedSlots(entityType).has(index)) return serializeStringSlot(value);
  if (realSlots.has(index)) {
    const trimmed = value.trim();
    if (trimmed === '') return '$';
    const numberValue = Number(trimmed);
    if (Number.isFinite(numberValue)) return toStepReal(numberValue);
    // A non-numeric value in a REAL slot used to fall through and be QUOTED,
    // producing the same ISO 10303-21 violation #2725 exists to prevent
    // (#2741). `StoreEditor.setAttribute` takes a string, so any UI text
    // field bound to a georeferencing REAL can deliver one; it does not need
    // a corrupt file.
    //
    // `null` means "leave the slot as the file had it". Simply returning
    // `currentToken` here would stop the invalid output but SILENTLY DISCARD
    // the edit - the exporter would then claim a modification it did not
    // carry, which is the exact misreport #2723/#2724/#2726 were written to
    // pin. The caller turns this into a warning, so a dropped edit is visible
    // rather than inferred from absence.
    return null;
  }
  return serializeAttributeValue(value, currentToken);
}

/**
 * Apply overlay attribute + positional overrides to an OVERLAY-CREATED
 * entity's argument list (#2006).
 *
 * Distinct from {@link applyAttributeMutations} / {@link applyPositionalMutations},
 * which rewrite a line read out of the source buffer. Here the whole line is
 * ours: it was serialized moments ago from the creation payload, so the
 * argument list is the authoring payload's, not the file's. That difference
 * is why this PADS — `entity_create` takes whatever positional list the
 * caller passes, so a wall authored with three arguments still has a real
 * `Tag` slot at index 7, and dropping the edit because the payload was short
 * would be the very data loss this fixes. The source-buffer path must not
 * pad: there a short line means a different schema, and growing a record we
 * did not author would corrupt it.
 *
 * Named and positional overrides resolve to a slot index up front and share
 * ONE padding rule. Two padding rules on one record is how the next bug
 * starts, and the argument for padding — the class is fixed at creation time,
 * so a short payload is partial authoring — never depended on which of the
 * two APIs queued the edit.
 */
export function applyOverlayEntityOverrides(
  argsText: string,
  entityType: string,
  attributeOverrides: Map<string, string> | null,
  positionalOverrides: Map<number, IfcAttributeValue> | null,
  schemaVersion: IfcSchemaVersion,
  onRejected?: (attrName: string, value: string) => void,
): string {
  const args = argsText.length > 0 ? splitTopLevelArgs(argsText) : [];
  const attrNames = getAttributeNamesAcrossSchemas(entityType);

  const named: Array<[number, string]> = [];
  for (const [attrName, value] of attributeOverrides ?? []) {
    const index = attrNames.indexOf(attrName);
    if (index >= 0) named.push([index, value]);
  }

  // Grow to the class's FULL declared arity as soon as any override names a
  // declared slot the creation payload never reached. Growing only as far as
  // the edited slot would emit eight arguments for an IfcWall that declares
  // nine: this parser tolerates the truncated record, a schema-validating
  // consumer rejects the file.
  //
  // An index PAST the declared layout is not a slot at all, so it cannot
  // justify growing the record and stays dropped — as does any override on a
  // class neither schema source knows, where there is no arity to grow to.
  let needsPad = named.some(([index]) => index >= args.length);
  if (!needsPad && positionalOverrides) {
    for (const [index] of positionalOverrides) {
      if (index >= args.length && index < attrNames.length) {
        needsPad = true;
        break;
      }
    }
  }
  if (needsPad) {
    while (args.length < attrNames.length) args.push('$');
  }

  // Every `named` index is < attrNames.length by construction, and padding
  // has taken args.length to at least that, so each one lands.
  const realSlots = getRealTypedSlots(entityType, schemaVersion);
  for (const [index, value] of named) {
    const serialized = serializeNamedAttribute(
      entityType,
      index,
      value,
      args[index],
      realSlots,
    );
    // Overlay-created entities take the same rejection: a non-numeric REAL is
    // invalid STEP whoever authored the record. The slot keeps the `$` this
    // path padded it with, rather than gaining a quoted string.
    if (serialized === null) {
      onRejected?.(attrNames[index] ?? `#${index}`, value);
      continue;
    }
    args[index] = serialized;
  }

  if (positionalOverrides && positionalOverrides.size > 0) {
    for (const [index, value] of positionalOverrides) {
      if (index < 0 || index >= args.length) continue;
      args[index] = serializePositionalOverride(
        entityType,
        index,
        value,
        args[index],
        realSlots,
        schemaVersion,
      );
    }
  }

  return args.join(',');
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

  const args = splitTopLevelArgs(entityText.slice(openParen + 1, closeParen));
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

/**
 * Serialize one positional override, composing the schema-aware passes:
 * explicit `{ real }`/`{ typed }` marker → SELECT auto-qualification
 * (`IFCBOOLEAN(.T.)`) → REAL forcing. For REAL forcing the current source
 * token is a secondary signal: replacing a value that was already a REAL
 * (`0.4`, `1.5E-7`) keeps it REAL even for entities the XSD index doesn't
 * cover, so a whole-number edit can't silently downgrade the slot.
 */
function serializePositionalOverride(
  entityType: string,
  index: number,
  value: IfcAttributeValue,
  currentToken: string,
  realSlots: ReadonlySet<number>,
  schemaVersion: IfcSchemaVersion,
): string {
  if (isTypedMarker(value)) return serializeStepValue(value);
  const qualified = serializeQualifiedSelectSlot(entityType, index, value);
  if (qualified !== null) return qualified;
  const forceReal = realSlots.has(index) || tokenIsRealLiteral(currentToken);
  return serializeStepValue(value, forceReal);
}
