/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provider guidance for reviewed native authoring (`model-authoring.ts`):
 * the exact contract, kept short so it fits beside evidence. Sent with the
 * `model.changes` guidance (`MODEL_CHANGE_OUTPUT_GUIDANCE`), so every
 * non-flow conversation can propose either kind.
 */

import { PROFILE_FIELDS, PROFILE_KINDS } from '@/lib/profile-section/profile-kinds';

const sectionDimensions = PROFILE_KINDS.map((type) => `${type} {${PROFILE_FIELDS[type].map((field) => field.name).join(',')}}`).join('; ');

export const MODEL_AUTHORING_OUTPUT_GUIDANCE =
  'When asked to create, copy, array, delete, move, turn, type, join or place elements, return only JSON {"version":1,"kind":"model.authoring",'
  + '"title":"Short title","rationale":"Why","units":"mm","frame":"storey-local","operations":[...]}. "units" is "m" or "mm" and applies to every length; '
  + 'coordinates are storey-local [x,y,z], Z up; angles are degrees counter-clockwise from above. Existing elements are '
  + '{"globalId","ifcClass","name"} exactly as in the evidence; elements created earlier in the batch are {"ref":"wall-1"}. Ops: '
  + 'element.create {ref, ifcClass: IfcWall|IfcSlab|IfcRoof|IfcPlate|IfcColumn|IfcBeam|IfcMember|IfcSpace, storey:{globalId}, name, params}: '
  + 'walls {start,end,thickness,height}, beams/members {start,end,width,height}, columns {position (base centre),width,depth,height}, '
  + 'slabs/roofs/plates {position (corner),width,depth,thickness}, spaces {position,width,depth,height}; '
  + 'slabs/roofs/plates/spaces also accept {Profile:"polygon", OuterCurve:[[x,y],...], position:[x,y,z] (optional, default zero), thickness or height}; 3–256 vertices and a bounded total outline work budget. '
  + 'beams/members may replace width/height with Profile; columns may replace width/depth with Profile. Profile is the native PascalCase {Type:Rectangle|I|L|T|U|C|Circle|RectangleHollow|CircleHollow, exact native dimension attributes}; every profile dimension uses the batch units. Do not combine Profile with rectangular section dimensions. '
  + `Required Profile dimensions: ${sectionDimensions}. Optional native fillet-radius attributes may be supplied when supported by that section; they use the same units. `
  + 'Positive fillet radii are written accurately but the preview uses the native sharp-corner approximation; review discloses this. '
  + 'Native builder acceptance is not a polygon topology/engineering validity verdict; use simple valid footprints. '
  + 'stair.create {ref,storey,params}: canonical Position:[x,y,z], NumberOfRisers, RiserHeight, TreadLength, Width, optional WaistThickness and Direction (radians, never scaled), Name/Description/ObjectType/Tag/GlobalId/FlightGlobalId/PredefinedType. Creates one IfcStair and its IfcStairFlight. '
  + 'railing.create {ref,storey,params}: canonical Path:[[x,y,z],...], Height, optional RailDiameter/PostDiameter/PostSpacing, Name/Description/ObjectType/Tag/GlobalId/PredefinedType. Explicit straight/sloped polyline only. The whole batch is bounded to 5000 native stair steps/railing posts. All length fields use batch units. '
  + 'stair.resize {target,expected:nativeStairExpected,size:{Width?,RiserHeight?,TreadLength?,WaistThickness?}}: expected is the complete native snapshot, verbatim (native IDs, count and metre lengths); convert only the new size lengths to batch units. Never invent unavailable expected data. NumberOfRisers is not edited in place. '
  + 'stair.delete {target} removes a uniquely owned single-flight assembly; railing.delete {target} removes one native railing. stair.replace/railing.replace {target,ref,storey,params} rebuild only a stair/railing as a new product record, with fresh GlobalId by default or explicitly supplied unique GlobalId (and FlightGlobalId for stairs), retaining native ownership/host refusals. Creation refs support later type/material/copy operations. '
  + 'Stair/railing command previews use solid steps (omit stair waist) and square rail/post sections. Custom diameters/vertical rail segments or existing stair edit/removal bodies can have no preview; review discloses limits. No inferred landings, multi-flight stairs, curved runs or railing in-place dimension editor. '
  + 'element.delete {target}; element.move {target, delta:[dx,dy]}; element.rotate {target, angleDeg}; '
  + 'element.resize {target, expected, size}: existing targets only; expected is the full current native dimensions: {kind:"wall",height,thickness}, {kind:"slab",thickness}, or {kind:"linear",length,width,cross,profiled:boolean}. size repeats kind and supplies one or more changed dimensions; linear length may state fixed:"start"|"end". Non-rectangular sections cannot change width/cross through resize. '
  + 'element.profile {target, expected:current Profile, Profile:new Profile}: existing centred beam/column/member extrusion sections only, with the same exact native fields and declared units as creation. Never invent the expected current dimensions/section; ask if unavailable. '
  + 'Selected evidence and explicit attached selections may supply nativeEdit: units:"m", dimensionsStatus/dimensions, profileStatus/Profile. Use available full dimensions or Profile as expected; unavailable is unknown, not zero. These SI snapshots are independent of displayed Qto units and do not grant edit permission or engineering suitability. Convert every expected/new length if choosing batch units:"mm". '
  + 'Resize uses the native hosted-fit/ownership checks; wall/slab thickness also updates only that occurrence\'s material layers. Review states unavailable geometry previews, omitted fillets and outer-body-only previews. '
  + 'element.split {target, expected, cut}: existing native wall, straight beam/column/member, or plan slab/roof/plate/space only. expected is the complete canonical native split snapshot {ok:true,kind,chain,placement:{parent,frame:{o,x,y,z}},storeyId}; never guess missing provenance, dimensions or frame. Only dimensional chain/Profile values and frame.o use batch units; IDs, direction vectors and frame axes keep their native values. cut is {kind:wall|linear,distance} from native axis start, or {kind:slab,a:[x,y],b:[x,y]}. Distances/coordinates use batch units. One row per distinct existing target, bounded explicit batches; the larger piece keeps identity and one new native identity is created. Review discloses cut-marker-only or unavailable preview and native opening assignments/refusals; it does not verify structural engineering intent. '
  + 'element.copy {target (existing or earlier ref), ref, offset:[dx,dy,dz], angleDeg? with pivot:[x,y], storey?:{globalId}, from?:[x,y]}; '
  + 'element.array {target, refs (one per new copy), mode:linear|polar, count (2..201 including original), anchor:[x,y], storey?, from?}; '
  + 'linear requires cursor:[x,y], distance? (spacing, or total span with fit:true), fit?; polar takes angleDeg (default360, full turns omit coincident copy). '
  + 'At most200 new copy roots per batch; native host/assembly dependents travel with each root. Copy an existing source before editing it in the same batch. '
  + 'Copy refs support later copies, type/material assignments, and hosted/join targets when their source is a wall. '
  + 'type.assign {target, expected: current type name or null, type:{globalId,name} or {create:{ifcClass,name}}}; '
  + 'material.assign {target, expected, material:{name, create}}; walls.join {walls:[a,b]}; '
  + 'hosted.create {kind: door|window|opening, host (a wall), offset (along the wall from its start to the centre), sill, width, height}. '
  + 'hosted.edit {target (existing door/window/opening), expected:{hostId,openingId,fillingId (null for bare openings),locationPointId,location:[x,y,z],offset,sill,size:{OverallWidth,OverallHeight} or null}, edit:{Offset?,Sill?,OverallWidth?,OverallHeight?}}. '
  + 'State the complete current canonical native binding, position and available size; ids are model-local EXPRESS ids, all location/position/dimension values use declared units. Do not guess missing state. At least one edit field is required. Movement supports bare openings; sizing requires the native door/window filling geometry. Wall hosts only, and native fit/overlap/layout/schema rules remain authoritative. Preview shows post-edit opening bounds, not the filling solid or detailed cut mesh, and reports unavailable geometry before Apply; prior geometry operations in the same model make this single-source hosted preview unavailable. '
  + 'Omit "expected" for elements created in the batch. Never invent dimensions, storeys or GlobalIds the user or evidence did not give; '
  + 'ask instead. Other operations (curtain walls, storey changes, trim/extend) are not available. The user reviews and previews every operation before anything is applied.';
