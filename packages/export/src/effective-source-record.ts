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
