/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { asSourceBytes, parseStepValue, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EffectiveEntityIndex } from './effective-index.js';
import { applySourceLineMutations } from './step-attribute-mutations.js';
import { readStepSlots } from './step-argument-parser.js';
import { effectiveCreatedRecord } from './effective-source-record.js';
import type { IfcSchemaVersion } from './schema-converter.js';

/** Compose the existing STEP writers; never invent a second override policy. */
export function effectiveAppearanceRecord(
  store: IfcDataStore, view: MutablePropertyView, index: EffectiveEntityIndex, id: number,
): string {
  const record = index.get(id);
  if (!record) throw new Error('Missing IFC entity during appearance cleanup; resources were retained.');
  const schema = (store.schemaVersion as IfcSchemaVersion) || 'IFC4';
  const named = new Map(view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value]));
  let createdRecord: { type: string; text: string } | null;
  try {
    createdRecord = effectiveCreatedRecord(view, id, store.schemaVersion);
  } catch {
    throw new Error('Invalid authored IFC entity during appearance cleanup; resources were retained.');
  }
  if (createdRecord) return createdRecord.text;
  const source = asSourceBytes(store.source);
  const original = source.decodeUtf8(record.byteOffset, record.byteOffset + record.byteLength);
  const result = applySourceLineMutations(view, id, original, record.type, named, schema, true);
  if (result.unreadable) throw new Error('Unreadable edited IFC entity during appearance cleanup; resources were retained.');
  return result.text;
}

/** URLReference occupies slot 5 after the inherited IfcSurfaceTexture fields. */
export function effectiveImageUri(line: string): string | undefined {
  const record = readStepSlots(line);
  if (record === null) throw new Error('Unreadable IFC image during appearance cleanup; resources were retained.');
  const argument = record.slots[5];
  if (argument === undefined) return undefined;
  const value = parseStepValue(argument.trim());
  return typeof value === 'string' ? value : undefined;
}
