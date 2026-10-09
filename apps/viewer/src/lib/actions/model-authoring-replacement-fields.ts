/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #7320: the existing ordinary and Stair builders' bounded input contracts. */
import type { StairInStoreParams,RailingInStoreParams } from '@ifc-lite/create';
import { AUTHORING_CLASSES,createParams,type AuthoringClass,type AuthoringUnits,type AxisParams,type BoxParams,type ExistingElement,type StoreyTarget } from './model-authoring';
import type { ShapeParams } from './model-authoring-shape-params';
import { parseStairRailingParams } from './model-authoring-stair-railing-fields';
import { parseRef,parseText,parseGlobalIdTarget,record } from './model-authoring-fields';
import type { NativeReplacementExpected } from './model-authoring-replacement';
interface Base { op:'element.replace';target:ExistingElement;ref:string;storey:StoreyTarget;name:string;expected:NativeReplacementExpected }
export type NativeReplacementOp=Base & (
 | {ifcClass:AuthoringClass;params:AxisParams|BoxParams|ShapeParams}
 | {ifcClass:'IfcStair';params:StairInStoreParams}
 | {ifcClass:'IfcRailing';params:RailingInStoreParams});
/** No reduced expectation can authorize a native source replacement. */
export function parseReplacementFields(value:Record<string,unknown>,target:ExistingElement,units:AuthoringUnits,at:string):NativeReplacementOp {
 if(!record(value.expected)||!record(value.expected.record)||typeof value.expected.record.type!=='string'||!Array.isArray(value.expected.record.attributes)||!record(value.expected.placement)||!Array.isArray(value.expected.types)||!Array.isArray(value.expected.materials)||!Number.isInteger(value.expected.storeyId))throw new Error(`${at}: expected needs the complete nativeReplacementExpected evidence`);
 const expected=value.expected as unknown as NativeReplacementExpected,name=parseText(value.name,`${at} destination Name`);
 const base={op:'element.replace' as const,target,ref:parseRef(value.ref,at),storey:parseGlobalIdTarget(value.storey,`${at} storey`),name,expected};
 if(value.ifcClass==='IfcStair'||value.ifcClass==='IfcRailing'){
  const params=value.ifcClass==='IfcStair'?parseStairRailingParams(value.params,'stair',units,at):parseStairRailingParams(value.params,'railing',units,at);
  if(params.Name!==undefined&&params.Name!==name)throw new Error(`${at}: destination Name and params.Name must agree`);
  return value.ifcClass==='IfcStair'?{...base,ifcClass:'IfcStair',params:{...params,Name:name} as StairInStoreParams}:{...base,ifcClass:'IfcRailing',params:{...params,Name:name} as RailingInStoreParams};
 }
 if(!AUTHORING_CLASSES.includes(value.ifcClass as AuthoringClass))throw new Error(`${at}: replacement destination must be a canonical ordinary class, IfcStair or IfcRailing`);
 const ifcClass=value.ifcClass as AuthoringClass;
 return {...base,ifcClass,params:createParams(value,ifcClass,units,at)};
}
