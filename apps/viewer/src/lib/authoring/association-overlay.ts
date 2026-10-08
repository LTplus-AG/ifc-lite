/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Material associations created in this session (#5876). The Properties panel
 * supplements source material reads with these current overlay associations.
 * Classification reads now use the canonical effective parser reader (#7131).
 */

import type { IfcAttributeValue, MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore, MaterialInfo } from '@ifc-lite/parser';

/** `RelatedObjects` / `Relating*` sit at 4 / 5 on every IfcRelAssociates*. */
const RELATED_OBJECTS = 4;
const RELATING = 5;

const refId = (value: IfcAttributeValue | undefined): number | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  const match = typeof value === 'string' ? /^#(\d+)$/.exec(value.trim()) : null;
  return match ? Number(match[1]) : null;
};
const text = (value: IfcAttributeValue | undefined): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
const isIfc2x3 = (schema: string | undefined) => schema?.toUpperCase() === 'IFC2X3';

function effectiveAttributes(view: MutablePropertyView, id: number, store?: IfcDataStore): IfcAttributeValue[] | null {
  if (view.isDeleted(id)) return null;
  const entity = view.getNewEntity(id) ?? store?.getEntity(id);
  if (!entity) return null;
  const attrs = [...entity.attributes];
  for (const [index, value] of view.getPositionalMutationsForEntity(id) ?? []) attrs[index] = value;
  return attrs;
}

function includesAny(related: IfcAttributeValue | undefined, ids: readonly number[]): boolean {
  return Array.isArray(related) && related.some((value) => ids.includes(refId(value) ?? -1));
}

/**
 * Live overlay rels of `relType` whose RelatedObjects include any of
 * `entityIds` (an element and the base it aliases, like the source readers
 * see), with the entity each relates.
 */
function overlayTargets(view: MutablePropertyView, relType: string, entityIds: readonly number[], store?: IfcDataStore): Array<{ id: number; attrs: IfcAttributeValue[] }> {
  const targets: Array<{ id: number; attrs: IfcAttributeValue[] }> = [];
  const created = Array.from(view.getNewEntitiesOfType(relType), (entity) => entity.expressId);
  const editedSource = store ? [...new Set(view.getMutations()
    .filter((mutation) => mutation.type === 'UPDATE_POSITIONAL_ATTRIBUTE' && mutation.attributeName === '@4')
    .map((mutation) => mutation.entityId))] : [];
  for (const relId of [...created, ...editedSource]) {
    const source = store?.getEntity(relId);
    if (!created.includes(relId) && source?.type.toUpperCase() !== relType) continue;
    const rel = effectiveAttributes(view, relId, store);
    if (!rel || !includesAny(rel[RELATED_OBJECTS], entityIds)) continue;
    // The parser already reports an original source association. Only add
    // recipients newly appended by this session's positional mutation.
    if (source && includesAny(source.attributes[RELATED_OBJECTS], entityIds)) continue;
    const target = refId(rel[RELATING]);
    const attrs = target === null ? null : effectiveAttributes(view, target, store);
    if (target !== null && attrs) targets.push({ id: target, attrs });
  }
  return targets;
}

/** Materials the session associated with any of `entityIds`, as the panel renders them. */
export function overlayMaterials(view: MutablePropertyView | null | undefined, entityIds: readonly number[], schema: string | undefined, store?: IfcDataStore): MaterialInfo[] {
  if (!view) return [];
  return overlayTargets(view, 'IFCRELASSOCIATESMATERIAL', entityIds, store).map((material) => ({
    type: 'Material' as const,
    name: text(material.attrs[0]),
    description: isIfc2x3(schema) ? undefined : text(material.attrs[1]),
    category: isIfc2x3(schema) ? undefined : text(material.attrs[2]),
  }));
}
