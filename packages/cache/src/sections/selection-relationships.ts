/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcStoreBase } from '@ifc-lite/data';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';
type Coverage = IfcStoreBase['selectionRelationshipIndex'];

/** v28 entity-index trailer. Without it cache hydration would reintroduce the
 * model-wide type inventory on the UI thread (#9947). */
export function writeSelectionRelationships(writer: BufferWriter, value: Coverage): void {
  writer.writeUint32(value ? 1 : 0);
  if (!value) return;
  writer.writeUint32(value.typeRows); writer.writeUint32(value.typeReferences);
  for (const ids of [value.missing, value.unverifiedTypeRows]) {
    writer.writeUint32(ids.length);
    for (const id of ids) writer.writeUint32(id);
  }
  writer.writeUint32(value.typeDefinitions.size);
  for (const [type, ids] of value.typeDefinitions) {
    writer.writeUint32(type); writer.writeUint32(ids.length);
    for (const id of ids) writer.writeUint32(id);
  }
}
export function readSelectionRelationships(reader: BufferReader): Coverage {
  const present = reader.readUint32();
  if (present === 0) return undefined;
  if (present !== 1) throw new Error('Corrupt selection relationship coverage flag');
  const typeRows = reader.readUint32(), typeReferences = reader.readUint32();
  const readIds = () => Array.from(reader.readUint32Array(reader.readUint32()));
  const missing = readIds(), unverifiedTypeRows = readIds(), typeDefinitions = new Map<number, number[]>();
  const count = reader.readUint32();
  for (let i = 0; i < count; i++) { const type = reader.readUint32(); typeDefinitions.set(type, readIds()); }
  return { typeRows, typeReferences, missing, unverifiedTypeRows, typeDefinitions };
}
