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
  writer.writeUint32(value.typeRows); writer.writeFloat64(value.typeReferences);
  for (const ids of [value.missing, value.unverifiedTypeRows, value.retryTypeRows]) {
    writer.writeUint32(ids.length);
    for (const id of ids) writer.writeUint32(id);
  }
  for (const map of [value.typeDefinitions, value.exceptionalSubjects, value.exceptionalDefinitionTargets]) {
    writer.writeUint32(map.size);
    for (const [key, ids] of map) {
      writer.writeUint32(key); writer.writeUint32(ids.length);
      for (const id of ids) writer.writeUint32(id);
    }
  }
  writer.writeUint32(value.typeExceptionalReferences.size);
  for (const [id, references] of value.typeExceptionalReferences) { writer.writeUint32(id); writer.writeFloat64(references); }
  writer.writeUint32(value.typeRefusals.size);
  for (const [id, reason] of value.typeRefusals) { writer.writeUint32(id); writer.writeString(reason); }
}
export function readSelectionRelationships(reader: BufferReader): Coverage {
  const present = reader.readUint32();
  if (present === 0) return undefined;
  if (present !== 1) throw new Error('Corrupt selection relationship coverage flag');
  const typeRows = reader.readUint32(), typeReferences = reader.readFloat64();
  const checkedReferences = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Corrupt selection relationship reference count');
    return value;
  };
  checkedReferences(typeReferences);
  const readIds = () => Array.from(reader.readUint32Array(reader.readUint32()));
  const missing = readIds(), unverifiedTypeRows = readIds(), retryTypeRows = readIds();
  const readMap = () => {
    const result = new Map<number, number[]>(), count = reader.readUint32();
    for (let i = 0; i < count; i++) { const key = reader.readUint32(); result.set(key, readIds()); }
    return result;
  };
  const typeDefinitions = readMap(), exceptionalSubjects = readMap(), exceptionalDefinitionTargets = readMap();
  const typeExceptionalReferences = new Map<number, number>(), count = reader.readUint32();
  for (let i = 0; i < count; i++) { const id = reader.readUint32(); typeExceptionalReferences.set(id, checkedReferences(reader.readFloat64())); }
  const typeRefusals = new Map<number, string>(), refusals = reader.readUint32();
  for (let i = 0; i < refusals; i++) { const id = reader.readUint32(); typeRefusals.set(id, reader.readString()); }
  return { typeRows, typeReferences, missing, unverifiedTypeRows, typeDefinitions, retryTypeRows,
    typeExceptionalReferences, typeRefusals, exceptionalSubjects, exceptionalDefinitionTargets };
}
