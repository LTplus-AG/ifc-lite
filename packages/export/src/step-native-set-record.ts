/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityExtractor, type IfcEntity } from '@ifc-lite/parser';
import type { IfcSchemaVersion } from './schema-converter.js';
import { applySourceLineMutationsReported } from './step-attribute-mutations.js';
import { serializeEntityArgs } from './attribute-real-slots.js';
import { entityLineText, type PropertySetContext } from './step-property-set-readers.js';
import { readStepSlots } from './step-argument-parser.js';

export function nativeSetLine(ctx: PropertySetContext, id: number, sourceSchema: IfcSchemaVersion,
  attributeMutations?: Map<string, string>, warnings: string[] = []): string {
  const created = ctx.mutationView?.getNewEntity?.(id);
  const original = created
    ? `#${id}=${created.type.toUpperCase()}(${serializeEntityArgs(created.type, created.attributes, sourceSchema)});`
    : entityLineText(ctx, id);
  if (original === null) throw new Error(`Type quantity source #${id} is unreadable`);
  return applySourceLineMutationsReported(ctx.applySourceLineMutations, warnings, id,
    original, created?.type ?? ctx.dataStore.entityIndex.byId.get(id)?.type ?? '', attributeMutations,
    sourceSchema, ctx.mutationView !== null).text;
}

export function decodeNativeSetLine(line: string, id: number): IfcEntity {
  const bytes = new TextEncoder().encode(line);
  const record = readStepSlots(line);
  if (!record) throw new Error(`Type quantity source #${id} has invalid STEP slots`);
  const entity = new EntityExtractor(bytes).extractEntity({ expressId: id, type: record.type,
    byteOffset: 0, byteLength: bytes.byteLength, lineNumber: 1 });
  if (!entity) throw new Error(`Type quantity source #${id} cannot be decoded`);
  return entity;
}

