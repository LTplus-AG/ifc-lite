/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP emission for the two IfcRelDefinesByProperties payloads `IfcCreator`
 * attaches to an element: IfcPropertySet and IfcElementQuantity, each with the
 * IfcPropertySingleValue / IfcPhysicalSimpleQuantity entities it owns.
 *
 * Split out of `ifc-creator.ts` so that file stays under its recorded
 * module-size budget (`scripts/module-size-allowlist.txt`), the same way
 * `ifc-creator-scheduling.ts` and `ifc-creator-cost.ts` are. The dependency on
 * the creator is narrowed to three callbacks — allocate-and-write an entity,
 * mint a GlobalId, and render the trailing IFC4-only attribute — so nothing
 * here reaches into the creator's private state. Behaviour is unchanged from
 * when these bodies lived on the class.
 */

import { esc, quantityValueField, serializePropertyValue } from './ifc-creator-math.js';
import type { EmitEntity } from './ifc-creator-cost.js';
import type { PropertySetDef, QuantitySetDef } from './types.js';

/**
 * Refuse an empty or sparse array before anything is emitted. Both aggregates
 * are `SET [1:?]`, so `[]` would write a schema-invalid `()`; and `map`
 * skips holes while `join` renders them as empty refs, so `new Array(1)`
 * would write the same instead of failing like the pre-split `for...of` loop.
 */
function assertDense(items: readonly unknown[], what: string): void {
  if (!Array.isArray(items) || items.length === 0) throw new Error(`${what} must contain at least one entry`);
  for (let i = 0; i < items.length; i++) {
    if (!(i in items) || items[i] == null) throw new Error(`${what}[${i}] is missing`);
  }
}

/** The creator hooks these emitters need. */
export interface DefinitionContext {
  emit: EmitEntity;
  newGlobalId: () => string;
  ownerRef: string;
  /** Renders a trailing IFC4/IFC4X3-only attribute, or nothing under IFC2X3. */
  ifc4Only: (value: string) => string;
}

/**
 * Emit an IfcPropertySet, its IfcPropertySingleValue properties, and the
 * IfcRelDefinesByProperties binding it to `elementId`. Returns the pset id.
 */
export function emitPropertySet(
  elementId: number,
  pset: PropertySetDef,
  context: DefinitionContext,
): number {
  assertDense(pset.Properties, `addIfcPropertySet '${pset.Name}': Properties`);
  const propIds = pset.Properties.map(prop =>
    context.emit('IFCPROPERTYSINGLEVALUE', `'${esc(prop.Name)}',$,${serializePropertyValue(prop)},$`));
  const refs = propIds.map(id => `#${id}`).join(',');
  const psetId = context.emit('IFCPROPERTYSET',
    `'${context.newGlobalId()}',${context.ownerRef},'${esc(pset.Name)}',$,(${refs})`);
  context.emit('IFCRELDEFINESBYPROPERTIES',
    `'${context.newGlobalId()}',${context.ownerRef},$,$,(#${elementId}),#${psetId}`);
  return psetId;
}

/**
 * Emit an IfcElementQuantity, its IfcPhysicalSimpleQuantity members, and the
 * IfcRelDefinesByProperties binding it to `elementId`. Returns the qset id.
 */
export function emitElementQuantity(
  elementId: number,
  qset: QuantitySetDef,
  context: DefinitionContext,
): number {
  assertDense(qset.Quantities, `addIfcElementQuantity '${qset.Name}': Quantities`);
  const qtyIds = qset.Quantities.map(qty =>
    context.emit(qty.Kind.toUpperCase(),
      `'${esc(qty.Name)}',$,${quantityValueField(qty)}${context.ifc4Only('$')}`));
  const refs = qtyIds.map(id => `#${id}`).join(',');
  const qsetId = context.emit('IFCELEMENTQUANTITY',
    `'${context.newGlobalId()}',${context.ownerRef},'${esc(qset.Name)}',$,$,(${refs})`);
  context.emit('IFCRELDEFINESBYPROPERTIES',
    `'${context.newGlobalId()}',${context.ownerRef},$,$,(#${elementId}),#${qsetId}`);
  return qsetId;
}
