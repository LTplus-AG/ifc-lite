/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification and material associations created in this session (#5876).
 *
 * The parser's on-demand readers (`extractClassificationsOnDemand`,
 * `extractAllMaterialsOnDemand`) read the source file only, so an
 * `IfcRelAssociatesClassification` / `IfcRelAssociatesMaterial` written into
 * the mutation overlay would never reach the Properties panel. These readers
 * resolve the overlay's own rels, and the entities they point at, into the
 * same `ClassificationInfo` / `MaterialInfo` shapes the panel already renders.
 */

import type { IfcAttributeValue, MutablePropertyView, NewEntity } from '@ifc-lite/mutations';
import type { ClassificationInfo, MaterialInfo } from '@ifc-lite/parser';

/** `RelatedObjects` / `Relating*` sit at 4 / 5 on every IfcRelAssociates*. */
const RELATED_OBJECTS = 4;
const RELATING = 5;

const refId = (value: IfcAttributeValue | undefined): number | null => {
  const match = typeof value === 'string' ? /^#(\d+)$/.exec(value.trim()) : null;
  return match ? Number(match[1]) : null;
};
const text = (value: IfcAttributeValue | undefined): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
const isIfc2x3 = (schema: string | undefined) => schema?.toUpperCase() === 'IFC2X3';

/**
 * Live overlay rels of `relType` whose RelatedObjects include any of
 * `entityIds` (an element and the base it aliases, like the source readers
 * see), with the entity each relates.
 */
function overlayTargets(view: MutablePropertyView, relType: string, entityIds: readonly number[]): NewEntity[] {
  const targets: NewEntity[] = [];
  for (const rel of view.getNewEntitiesOfType(relType)) {
    if (view.isDeleted(rel.expressId)) continue;
    const related = rel.attributes[RELATED_OBJECTS];
    if (!Array.isArray(related) || !related.some((r) => entityIds.includes(refId(r) ?? -1))) continue;
    const target = refId(rel.attributes[RELATING]);
    const entity = target === null ? null : view.getNewEntity(target);
    if (entity && !view.isDeleted(entity.expressId)) targets.push(entity);
  }
  return targets;
}

/** Classifications the session associated with any of `entityIds`, as the panel renders them. */
export function overlayClassifications(view: MutablePropertyView | null | undefined, entityIds: readonly number[], schema: string | undefined): ClassificationInfo[] {
  if (!view) return [];
  return overlayTargets(view, 'IFCRELASSOCIATESCLASSIFICATION', entityIds).map((reference) => {
    const source = refId(reference.attributes[3]);
    const classification = source === null ? null : view.getNewEntity(source);
    return {
      system: text(classification?.attributes[3]),
      // IFC2X3 names the code ItemReference; IFC4+ Identification. Same slot.
      identification: text(reference.attributes[1]),
      name: text(reference.attributes[2]),
      location: text(reference.attributes[0]),
      description: isIfc2x3(schema) ? undefined : text(reference.attributes[4]),
    };
  });
}

/** Materials the session associated with any of `entityIds`, as the panel renders them. */
export function overlayMaterials(view: MutablePropertyView | null | undefined, entityIds: readonly number[], schema: string | undefined): MaterialInfo[] {
  if (!view) return [];
  return overlayTargets(view, 'IFCRELASSOCIATESMATERIAL', entityIds).map((material) => ({
    type: 'Material' as const,
    name: text(material.attributes[0]),
    description: isIfc2x3(schema) ? undefined : text(material.attributes[1]),
    category: isIfc2x3(schema) ? undefined : text(material.attributes[2]),
  }));
}
