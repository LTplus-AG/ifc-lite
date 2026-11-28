// SPDX-License-Identifier: MPL-2.0

import { createSchemaEntityNameSnapshot, getSchemaRegistryForVersion, type IfcSourceBytes } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';
import { slotRef } from './schema-converter-structural-source.js';
import { skipStepTrivia } from './step-slot-grammar.js';
import type { IfcSchemaVersion } from './schema-converter.js';
import { readStepSlots } from './step-argument-parser.js';
import { retypeStepLine } from './retype.js';

export type RetypedAssignmentFilter = (line: string, id: number, warnings: string[]) => string | null;

/** Remove only assignments that a retype made incompatible in the source schema. */
export function createRetypedAssignmentFilter(
  schema: IfcSchemaVersion,
  effective: EffectiveEntityIndex,
  source: IfcSourceBytes | null | undefined,
): RetypedAssignmentFilter | undefined {
  if (schema === 'IFC5') return undefined;
  const registry = getSchemaRegistryForVersion(schema);
  const { resolve } = createSchemaEntityNameSnapshot(registry);

  // A relationship may precede its members. Resolve each changed source keyword
  // once through the writer, even when its line has not yet been emitted.
  const delivered = new Map<number, string>();
  function emittedType(id: number, original: string): string {
    const requested = effective.effectiveType(id, original);
    const before = original.toUpperCase();
    if (requested === before || effective.isOverlayCreated(id)) return requested;
    const cached = delivered.get(id);
    if (cached !== undefined) return cached;
    const ref = effective.get(id);
    const text = ref && source?.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
    const current = text && retypeStepLine(text, before, requested, null, schema) !== text ? requested : before;
    delivered.set(id, current);
    return current;
  }

  function compatible(occurrence: string, assigned: string): boolean | undefined {
    const occurrenceName = resolve(occurrence);
    const assignedName = resolve(assigned);
    if (!occurrenceName || !assignedName) return undefined;

    const assignedChain = registry.entities[assignedName].inheritanceChain;
    const chain = registry.entities[occurrenceName].inheritanceChain;
    if (!assignedChain || !chain) return undefined;
    for (let index = chain.length - 1; index >= 0; index--) {
      const name = chain[index];
      const expected = schema === 'IFC2X3' && (name === 'IfcDoor' || name === 'IfcWindow')
        ? `${name}Style`
        : `${name}Type`;
      if (registry.entities[expected]?.inheritanceChain?.includes('IfcTypeObject')) {
        return assignedChain.includes(expected);
      }
    }
    return false;
  }

  return (line, id, warnings) => {
    const record = readStepSlots(line);
    const typeId = slotRef(record?.slots[5]);
    const rawMembers = record?.slots[4];
    if (!record || typeId === null || !rawMembers || rawMembers[skipStepTrivia(rawMembers, 0)] !== '(') return line;
    // Frame the aggregate as a record so punctuation in comments stays trivia.
    const marker = '#0=IFCLIST';
    const members = readStepSlots(`${marker}${rawMembers};`);
    if (!members) return line;
    const originalType = effective.get(typeId)?.type;
    if (!originalType) return line;
    const currentType = emittedType(typeId, originalType);
    const typeChanged = originalType.toUpperCase() !== currentType;
    const removed: string[] = [];
    const retained = members.slots.filter(member => {
      const memberId = slotRef(member);
      if (memberId === null) return true;
      const original = effective.get(memberId)?.type;
      if (!original) return true;
      const current = emittedType(memberId, original);
      if (!typeChanged && original.toUpperCase() === current) return true;
      if (compatible(original, originalType) !== true || compatible(current, currentType) !== false) return true;
      removed.push(`#${memberId}`);
      return false;
    });
    if (removed.length === 0) return line;

    const summary = `Relationship #${id} (IFCRELDEFINESBYTYPE) lost its type assignment to #${typeId} for ${removed.join(', ')} after retyping.`;
    if (retained.length === 0) {
      warnings.push(`${summary} The empty relationship was withheld.`);
      return null;
    }
    warnings.push(summary);
    const slots = [...record.slots];
    slots[4] = `${members.prefix.slice(marker.length)}${retained.join(',')}${members.suffix.slice(0, -1)}`;
    return `${record.prefix}${slots.join(',')}${record.suffix}`;
  };
}
