/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Effective (base + pending edits) values a reviewed change is compared against. Read-only. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { extractEntityAttributesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { effectiveListStringAttribute } from '@/lib/lists/effective-provider-entities';
import type { ChangeScalar, ModelChange } from './model-change';

/** A value that cannot be compared or written by this layer (lists, references). */
export const UNSUPPORTED_VALUE = Symbol('unsupported-value');
export type CurrentValue = ChangeScalar | typeof UNSUPPORTED_VALUE;

export interface ModelReader {
  dataStore: IfcDataStore;
  view: MutablePropertyView;
}

/** The live view when the model has one; otherwise a private configured view that never enters the store. */
export function modelReader(state: ViewerState, modelId: string): ModelReader | null {
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  if (!dataStore) return null;
  const live = state.mutationViews.get(modelId);
  if (live) return { dataStore, view: live };
  const view = new MutablePropertyView(dataStore.properties || null, modelId);
  configureMutationView(view, dataStore);
  return { dataStore, view };
}

function scalarOf(value: unknown): CurrentValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : UNSUPPORTED_VALUE;
  return UNSUPPORTED_VALUE;
}

function baseAttribute(dataStore: IfcDataStore, expressId: number, name: string): string {
  if (name === 'Name') return dataStore.entities.getName(expressId) ?? '';
  const attrs = extractEntityAttributesOnDemand(dataStore, expressId);
  if (name === 'Description') return attrs.description ?? '';
  if (name === 'ObjectType') return attrs.objectType ?? '';
  if (name === 'Tag') return attrs.tag ?? '';
  return '';
}

export function currentValue(reader: ModelReader, expressId: number, change: ModelChange): CurrentValue {
  const { dataStore, view } = reader;
  switch (change.op) {
    case 'property.set': case 'property.delete':
      return scalarOf(view.getPropertyValue(expressId, change.pset, change.name));
    case 'quantity.set': {
      const set = view.getQuantitiesForEntity(expressId).find((candidate) => candidate.name === change.qset);
      return scalarOf(set?.quantities.find((quantity) => quantity.name === change.name)?.value);
    }
    case 'attribute.set':
      return effectiveListStringAttribute(dataStore, view, expressId, change.name, () => baseAttribute(dataStore, expressId, change.name));
  }
}

/**
 * Exact for text and booleans; numbers within a relative 1e-9 so a value that
 * round-tripped through JSON evidence still matches. Attributes treat empty
 * text and absence as the same value, as the STEP export does.
 */
export function sameValue(current: CurrentValue, expected: ChangeScalar, attribute = false): boolean {
  if (current === UNSUPPORTED_VALUE) return false;
  if (attribute) return (current ?? '') === (expected ?? '');
  if (typeof current === 'number' && typeof expected === 'number') {
    return Math.abs(current - expected) <= 1e-9 * Math.max(1, Math.abs(current), Math.abs(expected));
  }
  return current === expected;
}
