/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractTypeEntityOwnQuantities, getInheritanceChainAcrossSchemas, type IfcEntity } from '@ifc-lite/parser';
import type { QuantitySet } from '@ifc-lite/data';
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
  const canonical = extractTypeEntityOwnQuantities(ctx.dataStore, entityId);
  const available = new Map<string, TypeQuantitySource[]>();
  for (const [name, sources] of raw) {
    const identities = new Set(canonical.filter(set => set.name === name).map(set => set.globalId));
    const projected = sources.filter(source => identities.has(String(source.entity.attributes[0])));
    available.set(name, projected.length ? projected : sources);
  }
  const selected: Array<TypeQuantitySource | undefined> = [];
  const activeSets: QuantitySet[] = [];
  for (const qset of qsets) {
    const source = available.get(qset.name)?.shift();
    const view = ctx.mutationView;
    const memberNames = source?.members.map(id => {
      const line = nativeSetLine(ctx, id, pass.sourceSchema, pass.modifiedAttributes.get(id), pass.warnings);
      return decodeNativeSetLine(line, id).attributes[0];
    }) ?? [];
    const active = typeof view?.getQuantityMutation !== 'function' || [...qset.quantities.map(q => q.name), ...memberNames]
      .some(name => typeof name === 'string' && view.getQuantityMutation(entityId, qset.name, name) !== undefined);
    // Append-only history still names an undone edit; no current override means no copy.
    if (!active) continue;
    if (source) {
      replacements.set(source.setId, null);
      detachments.withholdTypeOwned(source.setId, entityId);
    }
    activeSets.push(qset);
    selected.push(source ? { ...source, unitSymbols: new Map(canonical.find(set => set.globalId === source.entity.attributes[0])
      ?.quantities.map(quantity => [quantity.name, quantity.unit]) ?? []) } : undefined);
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
    const mutation = name === null || usedNames.has(name) ? undefined
      : ctx.mutationView?.getQuantityMutation(entityId, qset.name, name);
    if (name !== null) usedNames.add(name);
    if (mutation?.operation === 'DELETE') continue;
    if (name !== null) remaining.delete(name);
    if (!mutation) { memberIds.push(id); continue; }
    const quantity = name === null ? undefined : qset.quantities.find(q => q.name === name);
    if (!quantity) continue;
    const targetType = quantityTypeToIfcType(quantity.type);
    if (!getInheritanceChainAcrossSchemas(entity.type).includes('IfcPhysicalSimpleQuantity')) {
      throw new Error(`Type quantity #${id} requires an explicit native entity edit`);
    }
    let copy = replaced(line, 3, toStepReal(quantity.value));
    // Omitted unit intent retains the native reference, including non-length units.
    if (mutation.unitRemoved) copy = replaced(copy, 2, '$');
    else if (mutation.unit !== undefined) {
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
