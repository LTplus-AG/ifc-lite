/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provider guidance for reviewed native authoring (`model-authoring.ts`):
 * the exact contract, kept short so it fits beside evidence. Sent with the
 * `model.changes` guidance (`MODEL_CHANGE_OUTPUT_GUIDANCE`), so every
 * non-flow conversation can propose either kind.
 */

export const MODEL_AUTHORING_OUTPUT_GUIDANCE =
  'When asked to create, delete, move, turn, type, join or place elements, return only JSON {"version":1,"kind":"model.authoring",'
  + '"title":"Short title","rationale":"Why","units":"mm","frame":"storey-local","operations":[...]}. "units" is "m" or "mm" and applies to every length; '
  + 'coordinates are storey-local [x,y,z], Z up; angles are degrees counter-clockwise from above. Existing elements are '
  + '{"globalId","ifcClass","name"} exactly as in the evidence; elements created earlier in the batch are {"ref":"wall-1"}. Ops: '
  + 'element.create {ref, ifcClass: IfcWall|IfcSlab|IfcRoof|IfcPlate|IfcColumn|IfcBeam|IfcMember|IfcSpace, storey:{globalId}, name, params}: '
  + 'walls {start,end,thickness,height}, beams/members {start,end,width,height}, columns {position (base centre),width,depth,height}, '
  + 'slabs/roofs/plates {position (corner),width,depth,thickness}, spaces {position,width,depth,height}; '
  + 'element.delete {target}; element.move {target, delta:[dx,dy]}; element.rotate {target, angleDeg}; '
  + 'type.assign {target, expected: current type name or null, type:{globalId,name} or {create:{ifcClass,name}}}; '
  + 'material.assign {target, expected, material:{name, create}}; walls.join {walls:[a,b]}; '
  + 'hosted.create {kind: door|window|opening, host (a wall), offset (along the wall from its start to the centre), sill, width, height}. '
  + 'Omit "expected" for elements created in the batch. Never invent dimensions, storeys or GlobalIds the user or evidence did not give; '
  + 'ask instead. Other operations (curtain walls, stairs, storey changes, splits) are not available. The user reviews and previews every operation before anything is applied.';
