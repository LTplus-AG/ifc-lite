/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { effectiveStoreyIds } from '@ifc-lite/create';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
import { uniqueSplitGuid } from './model-authoring-split';
import { nativeRootName } from './native-edit-evidence';

export interface RoomAutoAllEvidence {
  status: 'available' | 'unavailable';
  scope: 'all-current-storeys-in-one-explicit-model';
  requiresNativePreparation: true;
  storeys: { expressId:number; GlobalId:string; Name:string }[];
  reason?: string;
}
/** Pure native population publication. No candidates are invented from a selection or a bounding box. */
export function roomAutoAllEvidence(target:ModelEditTarget|null):RoomAutoAllEvidence {
  const base = {scope:'all-current-storeys-in-one-explicit-model' as const,requiresNativePreparation:true as const};
  const unavailable = (reason:string):RoomAutoAllEvidence=>({...base,status:'unavailable',storeys:[],reason});
  if (!target || !nativeLengthUnitAvailable(target)) return unavailable('Current editable IFC source/index/length unit is unavailable');
  if (!target.dataStore.schemaVersion || !['IFC2X3','IFC4','IFC4X3'].includes(target.dataStore.schemaVersion)) return unavailable('Current supported IFC schema is unavailable');
  const ids=effectiveStoreyIds(target.dataStore,target.view).sort((a,b)=>a-b);
  if (ids.length>128) return unavailable('More than 128 current storeys: complete AutoAll publication is unavailable');
  const storeys:RoomAutoAllEvidence['storeys']=[];
  for (const expressId of ids) {
    const record=effectiveMetadataRecord(target.dataStore,expressId,target.view);
    const GlobalId=record?.attributes[record.names.indexOf('GlobalId')];
    if (typeof GlobalId!=='string' || !uniqueSplitGuid(target.dataStore,target.editor,GlobalId)) return unavailable('A current storey Root identity is missing or ambiguous');
    storeys.push({expressId,GlobalId,Name:nativeRootName(target,expressId)});
  }
  // The existing attachment projection is bounded; an omitted tail must never imply complete membership.
  if (JSON.stringify(storeys).length>6000) return unavailable('Complete storey identities exceed the evidence projection limit');
  return {...base,status:'available',storeys};
}
