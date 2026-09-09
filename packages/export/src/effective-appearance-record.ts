/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { asSourceBytes, parseStepValue, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EffectiveEntityIndex } from './effective-index.js';
import { serializeEntityArgs } from './attribute-real-slots.js';
import { applyOverlayEntityOverrides } from './step-overlay-attribute-overrides.js';
import { applySourceLineMutations } from './step-attribute-mutations.js';
import { splitTopLevelArgs } from './step-argument-parser.js';
import { retypeArgTokens } from './retype.js';
import type { IfcSchemaVersion } from './schema-converter.js';

/** Compose the existing STEP writers; never invent a second override policy. */
export function effectiveAppearanceRecord(
  store: IfcDataStore, view: MutablePropertyView, index: EffectiveEntityIndex, id: number,
): string {
  const record = index.get(id);
  if (!record) throw new Error('Missing IFC entity during appearance cleanup; resources were retained.');
  const schema = (store.schemaVersion as IfcSchemaVersion) || 'IFC4';
  const named = new Map(view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value]));
  const created = view.getNewEntity(id);
  if (created) {
    const retype = view.getEntityTypeMutation(id);
    const type = retype?.newType ?? created.type;
    let args = serializeEntityArgs(created.type, created.attributes, schema);
    if (retype) args = retypeArgTokens(splitTopLevelArgs(args), created.type, type, retype.predefinedType, schema).tokens.join(',');
    args = applyOverlayEntityOverrides(args, type, named, view.getPositionalMutationsForEntity(id), schema);
    return `#${id}=${type.toUpperCase()}(${args});`;
  }
  const source = asSourceBytes(store.source);
  const original = source.decodeUtf8(record.byteOffset, record.byteOffset + record.byteLength);
  const result = applySourceLineMutations(view, id, original, record.type, named, schema, true);
  if (result.unreadable) throw new Error('Unreadable edited IFC entity during appearance cleanup; resources were retained.');
  return result.text;
}

/** URLReference occupies slot 5 after the inherited IfcSurfaceTexture fields. */
export function effectiveImageUri(line: string): string | undefined {
  const start = line.indexOf('('), end = line.lastIndexOf(')');
  if (start < 0 || end < start) throw new Error('Unreadable IFC image during appearance cleanup; resources were retained.');
  const argument = splitTopLevelArgs(line.slice(start + 1, end))[5];
  if (argument === undefined) return undefined;
  const value = parseStepValue(argument);
  return typeof value === 'string' ? value : undefined;
}
