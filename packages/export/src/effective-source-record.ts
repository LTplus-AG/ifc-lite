/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One source record as `StepExporter` will write it: the view's pending
 * retype, named and positional edits applied by THE exporter pipeline
 * (`applySourceLineMutations`), not by a second serializer.
 *
 * A read model that wants to agree with `bim.export.ifc()` byte for byte
 * (the cost read model, #4857) reads this text instead of re-deriving what
 * each edit kind serializes to — an enum slot written `.ADD.`, a positional
 * `AppliedValue`, a retyped class keyword, the `index >= args.length` skip on
 * a truncated record. Every one of those is decided here, once.
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { applySourceLineMutations } from './step-attribute-mutations.js';
import { serializeEntityArgs } from './attribute-real-slots.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { retypeArgTokens } from './retype.js';
import { applyOverlayEntityOverrides } from './step-overlay-attribute-overrides.js';
import type { IfcSchemaVersion } from './schema-converter.js';

export interface EffectiveSourceRecord {
  /** The record text the exporter writes (the source text when no edit reaches it). */
  text: string;
  /**
   * Pending edits the exporter DECLINES to write for this record, each as the
   * reason it gives: a record whose argument list does not scan, or a
   * non-numeric value for a REAL-typed slot. The exporter keeps the source
   * slot and warns; a reader must say so too rather than report the source
   * value as if no edit were pending.
   */
  notWritten: string[];
}

export function effectiveSourceRecord(
  view: MutablePropertyView,
  expressId: number,
  sourceText: string,
  sourceType: string,
  schemaVersion: string | undefined,
): EffectiveSourceRecord {
  const named = new Map(view.getAttributeMutationsForEntity(expressId).map(({ name, value }) => [name, value]));
  const notWritten: string[] = [];
  const result = applySourceLineMutations(
    view,
    expressId,
    sourceText,
    sourceType,
    named,
    (schemaVersion as IfcSchemaVersion | undefined) || 'IFC4',
    true,
    (name, value) => notWritten.push(`${name} = ${JSON.stringify(value)} is not a number and the slot is REAL-typed`),
  );
  if (result.unreadable) notWritten.push('the record\'s argument list does not scan, so no pending edit can be placed');
  return { text: result.text, notWritten };
}

/**
 * An overlay-CREATED entity's record, exactly as `StepExporter` — via
 * `writeOverlayCreatedEntities` — will write it: the authored attributes,
 * re-laid-out for a pending retype, then every attribute/positional edit made
 * AFTER the create applied on top. Extracted from `effectiveAppearanceRecord`
 * (#4857 PR A) so a reader that wants an overlay-created entity to read
 * exactly as the exported file will state it — the cost read model
 * (`CostMutationOverlay.created()`), so an authored `IfcCostItem` is visible
 * to `bim.cost` before the model is ever exported — goes through the same one
 * writer `effectiveAppearanceRecord` already used, rather than a second
 * re-implementation of retype + override layering.
 *
 * Returns `null` when `expressId` names no overlay-created entity (nothing to
 * report — the caller falls back to the source-record path). Throws when the
 * created entity's authored argument list does not scan for a pending retype:
 * the same condition `effectiveAppearanceRecord` throws on, since neither
 * caller can hand back a well-formed record. A `created()` caller in a read
 * model (as opposed to export, which must fail loudly) should catch this and
 * report a diagnostic instead of propagating it.
 */
export function effectiveCreatedRecord(
  view: MutablePropertyView,
  expressId: number,
  schemaVersion: string | undefined,
): { type: string; text: string } | null {
  const created = view.getNewEntity(expressId);
  if (!created) return null;
  const schema = (schemaVersion as IfcSchemaVersion | undefined) || 'IFC4';
  const named = new Map(view.getAttributeMutationsForEntity(expressId).map(({ name, value }) => [name, value]));
  const retype = view.getEntityTypeMutation(expressId);
  const type = retype?.newType ?? created.type;
  let args = serializeEntityArgs(created.type, created.attributes, schema);
  if (retype) {
    const slots = splitTopLevelStepArguments(args);
    if (slots === null) {
      throw new Error(`#${expressId}: the authored argument list does not scan, so the pending retype cannot be laid out`);
    }
    args = retypeArgTokens(slots, created.type, type, retype.predefinedType, schema).tokens.join(',');
  }
  args = applyOverlayEntityOverrides(args, type, named, view.getPositionalMutationsForEntity(expressId), schema);
  const upper = type.toUpperCase();
  return { type: upper, text: `#${expressId}=${upper}(${args});` };
}
