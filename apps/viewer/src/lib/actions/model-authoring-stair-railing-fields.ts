/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RailingInStoreParams, StairInStoreParams } from '@ifc-lite/create';
import type { AuthoringUnits } from './model-authoring';
import { parsePoint, parseText, record } from './model-authoring-fields';

export type StairRailingParams = {kind:'stair';params:StairInStoreParams}|{kind:'railing';params:RailingInStoreParams};
const coordinate={min:-10_000,max:10_000,signed:true};
const identities=['Name','Description','ObjectType','Tag','GlobalId','PredefinedType'];
const stairFields=['Position','Direction','NumberOfRisers','RiserHeight','TreadLength','Width','WaistThickness','FlightGlobalId',...identities];
const railingFields=['Path','Height','RailDiameter','PostDiameter','PostSpacing',...identities];
export const STAIR_RAILING_WORK_LIMIT=5000;
function length(v:unknown,at:string,units:AuthoringUnits):number{
 if(typeof v!=='number'||!Number.isFinite(v)||v<=0||(units==='mm'?v/1000:v)>1000)throw new Error(`${at} must be a finite positive length at most 1000 m`);
 return v;
}
/** Only explicit canonical builder fields; all dimensions remain declared-unit data until the native boundary. */
export function parseStairRailingParams(value:unknown,kind:'stair',units:AuthoringUnits,at:string):StairInStoreParams;
export function parseStairRailingParams(value:unknown,kind:'railing',units:AuthoringUnits,at:string):RailingInStoreParams;
export function parseStairRailingParams(value:unknown,kind:'stair'|'railing',units:AuthoringUnits,at:string):StairInStoreParams|RailingInStoreParams{
 if(!record(value))throw new Error(`${at} needs canonical ${kind} params`);
 const allowed=kind==='stair'?stairFields:railingFields;
 for(const key of Object.keys(value))if(!allowed.includes(key))throw new Error(`${at}: unsupported ${kind} field ${key}`);
 const identity:Record<string,string>={};
 for(const key of [...identities,...(kind==='stair'?['FlightGlobalId']:[])])if(value[key]!==undefined)identity[key]=parseText(value[key],`${at} ${key}`);
 if(kind==='stair'){
  const n=value.NumberOfRisers;
  if(typeof n!=='number'||!Number.isInteger(n)||n<1||n>4998)throw new Error(`${at}: NumberOfRisers must be an integer in [1,4998]`);
  const Direction=value.Direction;
  if(Direction!==undefined&&(typeof Direction!=='number'||!Number.isFinite(Direction)))throw new Error(`${at}: Direction must be finite radians`);
  return {...identity,Position:parsePoint(value.Position,units,coordinate,`${at} Position`),NumberOfRisers:n,
   RiserHeight:length(value.RiserHeight,`${at} RiserHeight`,units),TreadLength:length(value.TreadLength,`${at} TreadLength`,units),Width:length(value.Width,`${at} Width`,units),
   ...(Direction===undefined?{}:{Direction:Direction as number}),...(value.WaistThickness===undefined?{}:{WaistThickness:length(value.WaistThickness,`${at} WaistThickness`,units)})};
 }
 const Path=value.Path;
 if(!Array.isArray(Path)||Path.length<2||Path.length>STAIR_RAILING_WORK_LIMIT)throw new Error(`${at}: Path needs 2–${STAIR_RAILING_WORK_LIMIT} explicit points`);
 const points=Path.map((p,i)=>parsePoint(p,units,coordinate,`${at} Path[${i}]`));
 const optional:Pick<RailingInStoreParams,'RailDiameter'|'PostDiameter'|'PostSpacing'>={};
 for(const key of ['RailDiameter','PostDiameter','PostSpacing'] as const)if(value[key]!==undefined)optional[key]=length(value[key],`${at} ${key}`,units);
 let posts=1;
 for(let i=1;i<points.length;i++){
  const distance=Math.hypot(...points[i].map((n,j)=>n-points[i-1][j]));
  posts+=optional.PostSpacing===undefined?1:Math.max(1,Math.ceil(distance/optional.PostSpacing-1e-9));
  if(posts>STAIR_RAILING_WORK_LIMIT)throw new Error(`${at}: requested railing exceeds ${STAIR_RAILING_WORK_LIMIT} native posts`);
 }
 return {...identity,...optional,Path:points,Height:length(value.Height,`${at} Height`,units)};
}
export function stairParamsInMetres(params:StairInStoreParams,units:AuthoringUnits):StairInStoreParams{
 const m=(v:number)=>units==='mm'?v/1000:v;
 return {...params,Position:params.Position.map(m) as [number,number,number],RiserHeight:m(params.RiserHeight),TreadLength:m(params.TreadLength),Width:m(params.Width),...(params.WaistThickness===undefined?{}:{WaistThickness:m(params.WaistThickness)})};
}
export function railingParamsInMetres(params:RailingInStoreParams,units:AuthoringUnits):RailingInStoreParams{
 const m=(v:number)=>units==='mm'?v/1000:v;
 return {...params,Path:params.Path.map(p=>p.map(m) as [number,number,number]),Height:m(params.Height),...(params.RailDiameter===undefined?{}:{RailDiameter:m(params.RailDiameter)}),...(params.PostDiameter===undefined?{}:{PostDiameter:m(params.PostDiameter)}),...(params.PostSpacing===undefined?{}:{PostSpacing:m(params.PostSpacing)})};
}
