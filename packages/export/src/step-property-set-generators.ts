/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The STEP-entity generators for property sets and quantity sets: the two
 * loops the property-set/quantity-set collection phase's output
 * (`pass.newPropertySets` / `pass.newQuantitySets`) is fed through. Split
 * out of `step-property-sets.ts` (#3184).
 */

import { serializeValue, ref } from '@ifc-lite/parser';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { RandomSource } from '@ifc-lite/encoding';
import type { EffectiveEntityIndex } from './effective-index.js';
import { escapeStepString, toStepReal, quantityTypeToIfcType } from './step-serialization.js';
import { serializeNominalValue } from './declared-property-type.js';
import {
  type PropertySetContext,
  findUnitId,
  generateGlobalId,
  resolveOwnerHistoryRef,
} from './step-property-set-readers.js';

/**
 * Generate STEP entities for property sets
 */
export function generatePropertySetEntities(
  ctx: PropertySetContext,
  entityId: number,
  psets: PropertySet[],
  willBeEmitted: (id: number) => boolean,
  effective: EffectiveEntityIndex,
  typeOwnedPsetNames?: Set<string>,
  random?: RandomSource
): { lines: string[]; count: number; generatedTypeOwnedPsetIds: Map<string, number> } {
  const lines: string[] = [];
  let count = 0;
  const generatedTypeOwnedPsetIds = new Map<string, number>();

  for (const pset of psets) {
    const propertyIds: number[] = [];

    // Create IfcPropertySingleValue for each property
    for (const prop of pset.properties) {
      const propId = ctx.allocateExpressId();
      count++;

      // `prop.dataType`, not `prop.type` alone: regenerating the set rewrites
      // every property in it, and the shape-derived primitive would re-declare
      // the ones nobody edited (`IFCTEXT` → `IFCLABEL`, `IFCLENGTHMEASURE` →
      // `IFCREAL`). See `declared-property-type.ts` for when the source token
      // is trusted (#2482).
      const valueStr = serializeNominalValue(prop.value, prop.type, prop.dataType);
      const unitId = prop.unit ? findUnitId(ctx, prop.unit, effective) : null;
      const unitStr = unitId !== null ? ref(unitId) : null;

      // #ID=IFCPROPERTYSINGLEVALUE('Name',$,Value,Unit);
      const line = `#${propId}=IFCPROPERTYSINGLEVALUE('${escapeStepString(prop.name)}',$,${valueStr},${unitStr ? serializeValue(unitStr) : '$'});`;
      lines.push(line);
      propertyIds.push(propId);
    }

    // Create IfcPropertySet
    const psetId = ctx.allocateExpressId();
    count++;

    const propRefs = propertyIds.map(id => `#${id}`).join(',');
    const globalId = generateGlobalId(random);

    // #ID=IFCPROPERTYSET('GlobalId',#ownerHistory,'Name',$,(#props));
    const psetLine = `#${psetId}=IFCPROPERTYSET('${globalId}',${resolveOwnerHistoryRef(ctx, entityId, willBeEmitted)},'${escapeStepString(pset.name)}',$,(${propRefs}));`;
    lines.push(psetLine);

    if (typeOwnedPsetNames?.has(pset.name)) {
      generatedTypeOwnedPsetIds.set(pset.name, psetId);
    } else {
      // Create IfcRelDefinesByProperties to link pset to entity
      const relId = ctx.allocateExpressId();
      count++;

      const relGlobalId = generateGlobalId(random);
      // #ID=IFCRELDEFINESBYPROPERTIES('GlobalId',#ownerHistory,$,$,(#entity),#pset);
      const relLine = `#${relId}=IFCRELDEFINESBYPROPERTIES('${relGlobalId}',${resolveOwnerHistoryRef(ctx, entityId, willBeEmitted)},$,$,(#${entityId}),#${psetId});`;
      lines.push(relLine);
    }
  }

  return { lines, count, generatedTypeOwnedPsetIds };
}

/**
 * Generate STEP entities for quantity sets (IfcElementQuantity)
 */
export function generateQuantitySetEntities(
  ctx: PropertySetContext,
  entityId: number,
  qsets: QuantitySet[],
  willBeEmitted: (id: number) => boolean,
  random?: RandomSource
): { lines: string[]; count: number } {
  const lines: string[] = [];
  let count = 0;

  for (const qset of qsets) {
    const quantityIds: number[] = [];

    for (const q of qset.quantities) {
      const qId = ctx.allocateExpressId();
      count++;

      const ifcType = quantityTypeToIfcType(q.type);
      // #ID=IFCQUANTITYLENGTH('Name',$,$,Value,$);
      const val = toStepReal(q.value);
      const line = `#${qId}=${ifcType}('${escapeStepString(q.name)}',$,$,${val},$);`;
      lines.push(line);
      quantityIds.push(qId);
    }

    // Create IfcElementQuantity
    const qsetId = ctx.allocateExpressId();
    count++;

    const quantRefs = quantityIds.map(id => `#${id}`).join(',');
    const globalId = generateGlobalId(random);

    // #ID=IFCELEMENTQUANTITY('GlobalId',#ownerHistory,'Name',$,$,(#quants));
    const qsetLine = `#${qsetId}=IFCELEMENTQUANTITY('${globalId}',${resolveOwnerHistoryRef(ctx, entityId, willBeEmitted)},'${escapeStepString(qset.name)}',$,$,(${quantRefs}));`;
    lines.push(qsetLine);

    // Create IfcRelDefinesByProperties to link qset to entity
    const relId = ctx.allocateExpressId();
    count++;

    const relGlobalId = generateGlobalId(random);
    const relLine = `#${relId}=IFCRELDEFINESBYPROPERTIES('${relGlobalId}',${resolveOwnerHistoryRef(ctx, entityId, willBeEmitted)},$,$,(#${entityId}),#${qsetId});`;
    lines.push(relLine);
  }

  return { lines, count };
}
