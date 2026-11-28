// SPDX-License-Identifier: MPL-2.0

import { createSchemaEntityNameSnapshot, getSchemaRegistryForVersion } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';
import { BARE_REF_RE } from './reference-collector.js';
import type { IfcSchemaVersion } from './schema-converter.js';
import { readStepSlots, splitTopLevelListItems } from './step-argument-parser.js';

export type RetypedAssignmentFilter = (line: string, id: number, warnings: string[]) => string | null;

/** Remove only assignments that a retype made incompatible in the source schema. */
export function createRetypedAssignmentFilter(
  schema: IfcSchemaVersion,
  effective: EffectiveEntityIndex,
): RetypedAssignmentFilter | undefined {
  if (schema === 'IFC5') return undefined;
  const registry = getSchemaRegistryForVersion(schema);
  const { resolve } = createSchemaEntityNameSnapshot(registry);

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
    const typeRef = record?.slots[5]?.match(BARE_REF_RE);
    const rawMembers = record?.slots[4];
    const members = rawMembers?.trim();
    if (!record || !typeRef || rawMembers === undefined || !members?.startsWith('(') || !members.endsWith(')')) return line;

    const typeId = Number(typeRef[1]);
    const originalType = effective.get(typeId)?.type;
    if (!originalType) return line;
    const currentType = effective.effectiveType(typeId, originalType);
    const typeChanged = originalType.toUpperCase() !== currentType;
    const removed: string[] = [];
    const retained = splitTopLevelListItems(members.slice(1, -1)).filter(member => {
      const ref = member.match(BARE_REF_RE);
      const memberId = ref ? Number(ref[1]) : undefined;
      const original = memberId === undefined ? undefined : effective.get(memberId)?.type;
      if (memberId === undefined || !original) return true;
      const current = effective.effectiveType(memberId, original);
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
    const start = rawMembers.indexOf(members);
    const slots = [...record.slots];
    slots[4] = `${rawMembers.slice(0, start)}(${retained.join(',')})${rawMembers.slice(start + members.length)}`;
    return `${record.prefix}${slots.join(',')}${record.suffix}`;
  };
}
