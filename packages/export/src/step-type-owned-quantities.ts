/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractTypeEntityOwnQuantities, getInheritanceChainAcrossSchemas, type IfcEntity } from '@ifc-lite/parser';
import type { Quantity, QuantitySet } from '@ifc-lite/data';
import type { ExportPass, StepExportOptions } from './step-export-types.js';
import { generateGlobalId, getTypeOwnedHasPropertySetIds, findUnitId, type PropertySetContext } from './step-property-set-readers.js';
import type { SharedSetDetachments } from './step-pset-copy-on-write.js';
import { readStepSlots, replaceStepArgument } from './step-argument-parser.js';
import { quantityTypeToIfcType, toStepReal } from './step-serialization.js';
import { convertStepLine } from './schema-converter.js';
import { generateQuantityAtom } from './step-property-set-generators.js';
import { nativeSetLine, decodeNativeSetLine } from './step-native-set-record.js';

/** Native atoms are retained independently of the lossy numeric quantity projection. */
export interface TypeQuantitySource {
  readonly setId: number;
  readonly line: string;
  readonly entity: IfcEntity;
  readonly members: readonly number[];
  readonly quantities?: readonly Quantity[];
  readonly unitSymbols?: ReadonlyMap<string, string | undefined>;
}

/** Associate regenerated instances with their canonical source identity, not merely their name. */
export function collectTypeQuantitySources(
  pass: ExportPass, ctx: PropertySetContext, entityId: number, qsets: readonly QuantitySet[],
  affectedNames: ReadonlySet<string>, detachments: SharedSetDetachments,
): { qsets: QuantitySet[]; sourceSets: Array<TypeQuantitySource | undefined> } {
  const ids = getTypeOwnedHasPropertySetIds(ctx, entityId, pass.effective);
  pass.typeOwnedPsetIdsByEntity.set(entityId, ids);
  const raw = new Map<string, TypeQuantitySource[]>();
  const replacements = new Map<number, number | null>();
  for (const id of ids) {
    if (pass.effective.typeOf(id) !== 'IFCELEMENTQUANTITY') continue;
    const line = nativeSetLine(ctx, id, pass.sourceSchema, pass.modifiedAttributes.get(id), pass.warnings);
    const entity = decodeNativeSetLine(line, id);
    const name = entity.attributes[2];
    if (typeof name !== 'string' || !affectedNames.has(name)) continue;
    const members = entity.attributes[5];
    if (!Array.isArray(members) || members.some(ref => typeof ref !== 'number')) {
      throw new Error(`Type quantity set #${id} has unreadable native members`);
    }
    const sources = raw.get(name) ?? [];
    sources.push({ setId: id, line, entity, members: members as number[] });
    raw.set(name, sources);
    if (ctx.mutationView?.isQuantitySetDeleted?.(entityId, name)) {
      replacements.set(id, null);
      detachments.withholdTypeOwned(id, entityId);
    }
  }
  const canonical = extractTypeEntityOwnQuantities(ctx.dataStore, entityId, ctx.mutationView ?? undefined);
  const byGuid = new Map<string, TypeQuantitySource>();
  for (const sources of raw.values()) for (const source of sources) {
    const guid = source.entity.attributes[0];
    if (typeof guid !== 'string' || !guid || byGuid.has(guid)) throw new Error('Native type quantity definition identity is missing or ambiguous');
    byGuid.set(guid, source);
  }
  const selected: Array<TypeQuantitySource | undefined> = [];
  const activeSets: QuantitySet[] = [];
  const seen = new Set<string>();
  for (const qset of qsets) {
    const source = qset.globalId ? byGuid.get(qset.globalId) : undefined;
    if (qset.globalId && (!source || seen.has(qset.globalId))) throw new Error(`Projected type quantity identity ${qset.globalId} is missing or ambiguous among ${[...byGuid.keys()].join(',')}`);
    if (!source && raw.has(qset.name)) throw new Error('Projected type quantity identity cannot be associated with its native definition');
    if (qset.globalId) seen.add(qset.globalId);
    const base = canonical.find(set => set.globalId === qset.globalId);
    const quantities = base?.quantities.map(q => ({ name: q.name, type: q.type, value: q.value, unit: q.explicitUnit })) ?? [];
    if (source && JSON.stringify(quantities) === JSON.stringify(qset.quantities.map(q => ({ name: q.name, type: q.type, value: q.value, unit: q.unit })))) continue;
    if (source) {
      replacements.set(source.setId, null);
      detachments.withholdTypeOwned(source.setId, entityId);
      // Removing the last numeric member drops only this instance's ownership;
      // opaque native members still require a retained copied definition.
      const opaque = source.members.some(id => !getInheritanceChainAcrossSchemas(pass.effective.typeOf(id) ?? '').includes('IfcPhysicalSimpleQuantity'));
      if (qset.quantities.length === 0 && !opaque) continue;
    }
    activeSets.push(qset);
    selected.push(source ? { ...source, quantities, unitSymbols: new Map(base?.quantities.map(q => [q.name, q.explicitUnit]) ?? []) } : undefined);
  }
  pass.typeOwnedQuantityIdsByEntity.set(entityId, replacements);
  pass.addedTypeOwnedQuantityIds.set(entityId, []);
  pass.rewrittenEntityIds.add(entityId);
  return { qsets: activeSets, sourceSets: selected };
}

function replaced(line: string, slot: number, value: string): string {
  const result = replaceStepArgument(line, slot, value);
  if (result === null) throw new Error('Type quantity copy cannot preserve its native STEP slots');
  return result;
}

/** Copy edited atoms only. Untouched units, Formula and opaque physical quantities retain their IDs. */
export function generateTypeQuantityCopy(
  pass: ExportPass, options: StepExportOptions, ctx: PropertySetContext,
  entityId: number, qset: QuantitySet, source: TypeQuantitySource,
): { lines: string[]; count: number; setId: number } {
  const lines: string[] = [];
  const memberIds: number[] = [];
  const usedNames = new Set<string>();
  const remaining = new Map(qset.quantities.map(quantity => [quantity.name, quantity]));
  for (const id of source.members) {
    if (!pass.willBeEmitted(id) || pass.withheldRefIds.has(id)) continue;
    const line = nativeSetLine(ctx, id, pass.sourceSchema, pass.modifiedAttributes.get(id), pass.warnings);
    const entity = decodeNativeSetLine(line, id);
    const name = typeof entity.attributes[0] === 'string' ? entity.attributes[0] : null;
    const first = name !== null && !usedNames.has(name);
    if (name !== null) usedNames.add(name);
    const quantity = name === null ? undefined : qset.quantities.find(q => q.name === name);
    const base = name === null ? undefined : source.quantities?.find(q => q.name === name);
    const simple = getInheritanceChainAcrossSchemas(entity.type).includes('IfcPhysicalSimpleQuantity');
    if (simple && first && base && !quantity) continue;
    if (name !== null) remaining.delete(name);
    const changed = first && quantity && (!base || quantity.type !== base.type || quantity.value !== base.value || quantity.unit !== base.unit);
    if (!changed || !quantity) { memberIds.push(id); continue; }
    const mutation = ctx.mutationView?.getQuantityMutation(entityId, qset.name, quantity.name);
    const targetType = quantityTypeToIfcType(quantity.type);
    if (!getInheritanceChainAcrossSchemas(entity.type).includes('IfcPhysicalSimpleQuantity')) {
      throw new Error(`Type quantity #${id} requires an explicit native entity edit`);
    }
    let copy = replaced(line, 3, toStepReal(quantity.value));
    // Omitted unit intent retains the native reference, including non-length units.
    if (mutation?.unitRemoved) copy = replaced(copy, 2, '$');
    else if (mutation?.unit !== undefined) {
      if (name === null || mutation.unit !== source.unitSymbols?.get(name)) {
        const unitId = targetType === 'IFCQUANTITYLENGTH' ? findUnitId(ctx, mutation.unit, pass.effective) : null;
        if (unitId === null) throw new Error(`Type quantity #${id} unit edit cannot resolve a native reference`);
        copy = replaced(copy, 2, `#${unitId}`);
      }
    }
    const newId = ctx.allocateExpressId();
    const slots = readStepSlots(copy);
    if (!slots) throw new Error('Type quantity edited copy has invalid native slots');
    copy = `#${newId}=${targetType}(${slots.slots.join(',')});`;
    lines.push(copy); memberIds.push(newId);
  }
  for (const quantity of remaining.values()) {
    const atom = generateQuantityAtom(ctx, quantity, pass.effective);
    lines.push(atom.line); memberIds.push(atom.id);
  }
  if (memberIds.length === 0) throw new Error('An empty native type quantity copy cannot be emitted');
  const setId = ctx.allocateExpressId();
  // The copied root is a new identity when another type still owns the original.
  let setLine = replaced(source.line, 0, `'${generateGlobalId(options.guidRandom)}'`);
  setLine = replaced(setLine, 5, `(${memberIds.map(id => `#${id}`).join(',')})`);
  lines.push(setLine.replace(/^\s*#\d+\s*=/, `#${setId}=`));
  const converted = pass.converting ? lines.flatMap(line => {
    const result = convertStepLine(line, pass.sourceSchema, pass.schema, options.guidRandom,
      pass.slotFill, pass.withheldRefIds, pass.ifc4Slots, pass.enums);
    if (result === null) throw new Error('Native type quantity copy is unsupported in the target schema');
    return [result];
  }) : lines;
  return { lines: converted, count: converted.length, setId };
}
