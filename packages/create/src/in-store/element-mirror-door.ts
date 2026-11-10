// SPDX-License-Identifier: MPL-2.0
import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { AnchorEntityReader } from './resolve-anchor.js';
import { liveEntityConforms } from './resolve-relations.js';
import { refId } from './host-geometry-frame.js';

/** Occurrence operation plus an independent style/type for mirrored doors.
 * A shared IfcDoorStyle (IFC2X3) or IfcDoorType must keep unselected users' hand. */
export function mirrorDoorHandedness(store: IfcDataStore, editor: StoreEditor, products: ReadonlySet<number>): void {
  const view = editor.getMutationView(), reader = new AnchorEntityReader(store, view);
  const doors = new Set([...products].filter(id => liveEntityConforms(store, id, 'IfcDoor', view)));
  if (!doors.size) return;
  for (const id of doors) {
    const door = reader.entity(id)!;
    const slot = door.names.indexOf('OperationType');
    const operation = flipped(door.attributes[slot]);
    if (slot >= 0 && operation !== null) editor.setPositionalAttribute(id, slot, operation);
  }
  const clones = new Map<number, number>();
  // Snapshot membership before emitting relationships of the same class.
  for (const id of [...reader.ids('IFCRELDEFINESBYTYPE')]) {
    const rel = reader.entity(id)!;
    const related = rel.attributes[4], typeId = refId(rel.attributes[5]);
    if (!Array.isArray(related) || typeId === null) continue;
    const selected = related.filter(value => doors.has(refId(value) ?? -1));
    if (!selected.length) continue;
    if (related.some(value => refId(value) === null)) throw new Error(`Mirror door type relationship #${id} is unreadable`);
    if (!liveEntityConforms(store, typeId, 'IfcDoorStyle', view)
      && !liveEntityConforms(store, typeId, 'IfcDoorType', view)) continue;
    const type = reader.entity(typeId)!;
    const slot = type.names.indexOf('OperationType');
    const operation = flipped(type.attributes[slot]);
    if (slot < 0 || operation === null) continue;
    let clone = clones.get(typeId);
    if (clone === undefined) {
      const attributes = [...structuredClone(type.attributes)];
      attributes[type.names.indexOf('GlobalId')] = generateIfcGuid();
      const nameSlot = type.names.indexOf('Name');
      if (nameSlot >= 0 && typeof attributes[nameSlot] === 'string') attributes[nameSlot] += ' (mirrored)';
      attributes[slot] = operation;
      clone = editor.addEntity(type.type, attributes as Parameters<StoreEditor['addEntity']>[1]).expressId;
      clones.set(typeId, clone);
    }
    const remaining = related.filter(value => !doors.has(refId(value) ?? -1)).map(value => `#${refId(value)}`);
    if (remaining.length) editor.setPositionalAttribute(id, 4, remaining);
    else editor.removeEntity(id);
    const attributes = [...structuredClone(rel.attributes)];
    attributes[rel.names.indexOf('GlobalId')] = generateIfcGuid();
    attributes[4] = selected;
    attributes[5] = `#${clone}`;
    editor.addEntity(rel.type, attributes as Parameters<StoreEditor['addEntity']>[1]);
  }
}

function flipped(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = value.replace(/LEFT|RIGHT/g, side => side === 'LEFT' ? 'RIGHT' : 'LEFT');
  return result === value ? null : result;
}
