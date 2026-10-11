/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { entityName, typeOf } from '@/lib/commands/modeling/authored-kinds';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { NativeReadState } from './model-authoring-read-target';

export interface NativeTypeEvidence {
  status: 'typed' | 'untyped' | 'unavailable';
  expected: { GlobalId: string; Name: string } | null;
}

/** Current canonical occurrence/type binding, including unsaved type roots and metadata (#7267). */
export function nativeTypeEvidence(_state: NativeReadState, target: ModelEditTarget | null, expressId: number): NativeTypeEvidence {
  if (!target || target.view.isDeleted(expressId)) return { status: 'unavailable', expected: null };
  const typeId = typeOf(target, expressId);
  if (typeId === null) return { status: target.dataStore.source.byteLength > 0 || target.view.getNewEntity(expressId)
    ? 'untyped' : 'unavailable', expected: null };
  const GlobalId = effectiveMetadataRecord(target.dataStore, typeId, target.view)?.attributes[0];
  const Name = entityName(target, typeId);
  return typeof GlobalId === 'string' && isValidIfcGuid(GlobalId) && Name.length <= 200 ? { status: 'typed', expected: { GlobalId, Name } }
    : { status: 'unavailable', expected: null };
}
