/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What an element's top is attached to (#9013, #9296).
 *
 * IFC has no standard top constraint, so attachment is RECORDED, never
 * inferred from a height that happens to equal the current spacing (a fixed
 * 3.00 m wall under a 3.00 m storey is still a fixed wall). Walls, columns,
 * beams and members, and curtain walls read the same records:
 *
 * 1. `IfcLite_StoreyAttachment.TopConstraint` (IfcLabel), written by the
 *    Model workspace and `bim.store`:
 *    - the GlobalId of the storey the top is attached to;
 *    - `NextStoreyAbove`, for an element drawn attached before any storey
 *      above existed (the blank-file case): the first storey added directly
 *      above binds it;
 *    - the GlobalId of a slab: the top reaches the slab's underside and
 *      follows it when the slab's storey moves;
 *    - `Fixed`, an explicit fixed height (it overrides a Revit record).
 *    GlobalIds survive export, reload and schema conversion, and the property
 *    is an ordinary overlay write, so it undoes with its edit.
 * 2. `IfcLite_StoreyAttachment.TopBinding` (IfcLabel), how a storey target is
 *    meant (#9296):
 *    - `Relative`: Archicad's "home storey + 1". The element follows whatever
 *      storey is next above its own: a storey inserted below the target
 *      re-binds it, and a copy to another storey binds the copy to the storey
 *      above its new one.
 *    - `Explicit`: Revit's "Up to level: X". The element stays on that storey
 *      whatever is inserted or copied.
 *    A record without one (every file written before #9296) is relative when
 *    its storey is the next storey above the element's own, which is what the
 *    Model workspace's "To storey above" wrote, and explicit otherwise. So an
 *    old file keeps its meaning for every edit it could already make.
 * 3. Revit's own export, `Constraints` › `Top Constraint` = `Up to level:
 *    <name>`: an explicit binding, matched to a storey by name. `Unconnected`
 *    (or no record) is a fixed height.
 *
 * A record that names nothing it can follow (a deleted storey's GlobalId, a
 * Revit level renamed or shared by two storeys, a roof, which is not
 * supported until pitched roofs land) is not guessed at: `topAttachmentProblem`
 * reports it and the plan lists it as a notice.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { storeyNeighbour, type StoreyInventory } from './storey-model.js';

export const STOREY_ATTACHMENT_PSET = 'IfcLite_StoreyAttachment';
export const TOP_CONSTRAINT = 'TopConstraint';
export const TOP_BINDING = 'TopBinding';
export const NEXT_STOREY_ABOVE = 'NextStoreyAbove';
export const FIXED_HEIGHT = 'Fixed';
export const RELATIVE_BINDING = 'Relative';
export const EXPLICIT_BINDING = 'Explicit';

const REVIT_PSET = 'Constraints';
const REVIT_TOP = 'Top Constraint';
const REVIT_LEVEL = /^\s*up to level\s*:\s*(.+?)\s*$/i;

/** Element classes a top may attach to, with how their underside is read (`storey-attachment-target.ts`). */
const SLAB_TYPES = new Set(['IFCSLAB', 'IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE']);
/**
 * Classes a top may name but cannot follow yet. Attach-to-roof needs the
 * pitched roof's underside along the element (round 3 of #9296): add its
 * reader beside the slab's in `storey-attachment-target.ts` and move the
 * class into `SLAB_TYPES`' role there.
 */
const PENDING_TARGET_TYPES = new Map([['IFCROOF', 'a roof (attaching to a roof is not supported yet)']]);

export type TopBinding = 'relative' | 'explicit';

export interface TopAttachment {
  /**
   * The storey the top follows: the attached storey, or the storey that holds
   * the attached slab. Null while unbound (`NextStoreyAbove` with no storey above yet).
   */
  readonly targetStoreyId: number | null;
  /** What the top reaches: a storey's floor, or an element's underside. */
  readonly kind: 'storey' | 'element';
  /** The attached slab, for `kind: 'element'`. */
  readonly targetElementId?: number;
  /** How a storey target is meant; an element target is always explicit. */
  readonly binding: TopBinding;
  readonly source: 'ifclite' | 'revit';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The storey that contains `elementId` (through IfcRelContainedInSpatialStructure), or null. */
export function homeStoreyOf(inventory: StoreyInventory, elementId: number): number | null {
  const storeyIds = new Set(inventory.storeys.map((storey) => storey.expressId));
  const rel = (inventory.incoming.get(elementId) ?? []).find((candidate) => candidate.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE');
  return rel && storeyIds.has(rel.parent) ? rel.parent : null;
}

/** Live slabs and pending targets by GlobalId, read once per inventory. */
const targetIndexes = new WeakMap<StoreyInventory, Map<string, { id: number; type: string }>>();
function targetByGlobalId(inventory: StoreyInventory, globalId: string): { id: number; type: string } | null {
  let index = targetIndexes.get(inventory);
  if (!index) {
    index = new Map();
    for (const type of [...SLAB_TYPES, ...PENDING_TARGET_TYPES.keys()]) {
      for (const id of inventory.reader.ids(type)) {
        const guid = inventory.reader.entity(id)?.attributes[0];
        if (typeof guid === 'string') index.set(guid, { id, type });
      }
    }
    targetIndexes.set(inventory, index);
  }
  return index.get(globalId) ?? null;
}

function recordedBinding(inventory: StoreyInventory, elementId: number): TopBinding | null {
  const recorded = text(inventory.view.getPropertyValue(elementId, STOREY_ATTACHMENT_PSET, TOP_BINDING));
  if (recorded === RELATIVE_BINDING) return 'relative';
  if (recorded === EXPLICIT_BINDING) return 'explicit';
  return null;
}

/** The recorded top attachment of an element, or null for a fixed height. */
export function readTopAttachment(inventory: StoreyInventory, elementId: number): TopAttachment | null {
  const view = inventory.view;
  const own = text(view.getPropertyValue(elementId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT));
  if (own) {
    if (own === FIXED_HEIGHT) return null;
    if (own === NEXT_STOREY_ABOVE) return { targetStoreyId: null, kind: 'storey', binding: 'relative', source: 'ifclite' };
    const storey = inventory.storeys.find((candidate) => candidate.GlobalId === own);
    if (storey) {
      const home = homeStoreyOf(inventory, elementId);
      const next = home === null ? null : storeyNeighbour(inventory, home, 1);
      // Legacy records: "To storey above" wrote the next storey's GlobalId.
      const binding = recordedBinding(inventory, elementId) ?? (next?.expressId === storey.expressId ? 'relative' : 'explicit');
      return { targetStoreyId: storey.expressId, kind: 'storey', binding, source: 'ifclite' };
    }
    const element = targetByGlobalId(inventory, own);
    if (element && SLAB_TYPES.has(element.type)) {
      const holder = homeStoreyOf(inventory, element.id);
      // A slab no storey holds cannot be followed through a storey edit.
      return holder === null ? null : { targetStoreyId: holder, kind: 'element', targetElementId: element.id, binding: 'explicit', source: 'ifclite' };
    }
    // A GlobalId naming no live storey or slab (it was deleted) leaves the element fixed.
    return null;
  }
  const revit = text(view.getPropertyValue(elementId, REVIT_PSET, REVIT_TOP));
  const level = revit ? REVIT_LEVEL.exec(revit)?.[1] : undefined;
  if (!level) return null;
  const named = inventory.storeys.filter((storey) => storey.Name.trim().toLowerCase() === level.toLowerCase());
  // Two storeys with that name: refuse to pick one.
  return named.length === 1 ? { targetStoreyId: named[0].expressId, kind: 'storey', binding: 'explicit', source: 'revit' } : null;
}

/**
 * Why an element's recorded attachment cannot be followed, or null when it
 * can (or the element records none).
 */
export function topAttachmentProblem(inventory: StoreyInventory, elementId: number): string | null {
  const view = inventory.view;
  const own = text(view.getPropertyValue(elementId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT));
  if (own) {
    if (own === FIXED_HEIGHT || own === NEXT_STOREY_ABOVE) return null;
    if (inventory.storeys.some((storey) => storey.GlobalId === own)) return null;
    const element = targetByGlobalId(inventory, own);
    if (element && SLAB_TYPES.has(element.type)) {
      return homeStoreyOf(inventory, element.id) === null ? `its top is attached to slab #${element.id}, which no storey contains` : null;
    }
    if (element) return `its top is attached to ${PENDING_TARGET_TYPES.get(element.type) ?? `#${element.id}`}`;
    return `its top is attached to a storey or slab that no longer exists (${own})`;
  }
  const level = REVIT_LEVEL.exec(text(view.getPropertyValue(elementId, REVIT_PSET, REVIT_TOP)) ?? '')?.[1];
  if (!level) return null;
  const named = inventory.storeys.filter((storey) => storey.Name.trim().toLowerCase() === level.toLowerCase()).length;
  if (named === 1) return null;
  return named === 0
    ? `Revit records its top up to level "${level}", which no storey is called`
    : `Revit records its top up to level "${level}", which ${named} storeys are called`;
}

/**
 * Record an element as attached to `target` (a storey or slab GlobalId, or
 * `NextStoreyAbove`). `binding` says how a storey target is meant; omitted,
 * any recorded binding is left as it is (a re-bind keeps its kind).
 */
export function writeTopAttachment(view: MutablePropertyView, elementId: number, target: string, binding?: TopBinding): void {
  view.setProperty(elementId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT, target, PropertyValueType.Label);
  if (binding) {
    view.setProperty(elementId, STOREY_ATTACHMENT_PSET, TOP_BINDING, binding === 'relative' ? RELATIVE_BINDING : EXPLICIT_BINDING, PropertyValueType.Label);
  }
}

/**
 * Make an element fixed-height again. An element Revit recorded as attached
 * gets an explicit `Fixed` record (the Revit property is the file's own and
 * stays); any other loses the IfcLite record.
 */
export function clearTopAttachment(view: MutablePropertyView, elementId: number): void {
  const revit = text(view.getPropertyValue(elementId, REVIT_PSET, REVIT_TOP));
  if (revit && REVIT_LEVEL.test(revit)) {
    view.setProperty(elementId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT, FIXED_HEIGHT, PropertyValueType.Label);
  } else if (view.getPropertyValue(elementId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT) !== null) {
    view.deleteProperty(elementId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT);
  }
  if (view.getPropertyValue(elementId, STOREY_ATTACHMENT_PSET, TOP_BINDING) !== null) {
    view.deleteProperty(elementId, STOREY_ATTACHMENT_PSET, TOP_BINDING);
  }
}
