/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Document field reads over the same parsed model plus overlay as charts (#5249). */
import type { ElementFieldBinding } from '@ifc-lite/charts';
import { createElementFieldReader, type ElementFieldReader } from '../charts/element-field-reader.js';
import type { BindingModel } from './bindings.js';

const readers = new WeakMap<BindingModel, ElementFieldReader>();
const changedGuidCandidates = new WeakMap<BindingModel, Set<number>>();

function readerFor(model: BindingModel): ElementFieldReader {
  let reader = readers.get(model);
  if (!reader) {
    reader = createElementFieldReader(model.store, model.view);
    readers.set(model, reader);
  }
  return reader;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map(format).join(', ');
  return String(value);
}

/** A source GUID may have changed; a new entity has no source-table GUID index. */
export function findEffectiveElementId(model: BindingModel, globalId: string): number {
  const sourceId = model.store.entities.getExpressIdByGlobalId(globalId);
  if (!model.view) return sourceId;
  const view = model.view;
  const reader = readerFor(model);
  const guid: ElementFieldBinding = { kind: 'attribute', attributeName: 'GlobalId', valueKind: 'category' };
  const matches = (id: number): boolean => !view.isDeleted(id) && reader.read(id, guid) === globalId;
  if (sourceId > 0 && matches(sourceId)) return sourceId;
  let changedIds = changedGuidCandidates.get(model);
  if (!changedIds) {
    changedIds = new Set(view.getEffectiveChanges().map((change) => change.entityId));
    for (const created of view.getNewEntities()) changedIds.add(created.expressId);
    changedGuidCandidates.set(model, changedIds);
  }
  for (const id of changedIds) if (id !== sourceId && matches(id)) return id;
  return -1;
}

/** What the insert-field picker can resolve on this effective element. */
export function effectivePropertyPaths(model: BindingModel, id: number): Array<{ setName: string; name: string }> {
  const catalog = readerFor(model).discover([id]);
  const paths: Array<{ setName: string; name: string }> = [];
  for (const options of catalog.properties.values()) for (const option of options) {
    if (option.binding.kind === 'property') paths.push({ setName: option.binding.psetName, name: option.binding.propertyName });
  }
  for (const options of catalog.quantities.values()) for (const option of options) {
    if (option.binding.kind === 'quantity') paths.push({ setName: option.binding.qsetName, name: option.binding.quantityName });
  }
  return paths;
}

export function effectiveAttribute(model: BindingModel, id: number, attributeName: string): string {
  const binding: ElementFieldBinding = { kind: 'attribute', attributeName, valueKind: 'category' };
  return format(readerFor(model).read(id, binding));
}

/** Undefined means the field does not exist on the effective element. */
export function effectiveProperty(model: BindingModel, id: number, setName: string, name: string): string | undefined {
  const catalog = readerFor(model).discover([id]);
  const property = catalog.properties.get(setName)?.find((option) => option.binding.kind === 'property' && option.binding.propertyName === name);
  const quantity = catalog.quantities.get(setName)?.find((option) => option.binding.kind === 'quantity' && option.binding.quantityName === name);
  const option = property ?? quantity;
  if (!option) return undefined;
  const resolved = readerFor(model).readResolved(id, option.binding);
  if (resolved.status === 'unsupported') return undefined;
  const value = format(resolved.value);
  return resolved.unit && value ? `${value} ${resolved.unit}` : value;
}
