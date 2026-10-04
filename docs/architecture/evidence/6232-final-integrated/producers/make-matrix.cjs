// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const dir=__dirname;
const rows=[
 ['element.split','splitElements','edit_element_geometry: split','element-split.test.ts / physical-edit.test.ts','physical: split'],
 ['wall.place','addWall','run_flow: wall','ordinary-element.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts','physical: authored-wall'],
 ['wall.moveEndpoint','resizeWall','edit_element_geometry: wall_endpoints','element-transform-size.e2e.test.ts / physical-edit.test.ts','physical: endpoints'],
 ['slab.place','addSlab','run_flow: slab','ordinary-element.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts','placement: slab'],
 ['column.place','addColumn','run_flow: column','column.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts','align: column-a/column-b'],
 ['beam.place','addBeam','run_flow: beam','beam.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts','placement: beam'],
 ['room.place','roomCommand','room_command: query/auto/pick/footprint/update/edit','room-command.test.ts / room-place.test.tsx / room-layout.test.tsx','room: query/pick/cut; other modes native MCP'],
 ['opening.place','addOpening','place_opening','hosted-place.test.ts / hosted-place.test.tsx','placement: opening'],
 ['door.place','addHostedDoor','place_door','hosted-place.test.ts / hosted-place.test.tsx','placement: door'],
 ['window.place','addHostedWindow','place_window','hosted-place.test.ts / hosted-place.test.tsx','placement: window'],
 ['hosted.slide','editHostedElement','edit_hosted_element','hosted-place.test.ts / store-adapter-hosted.test.ts','placement: hosted-slide'],
 ['plan.move','transformElements','edit_element_geometry: transform/move','store-adapter-native-physical-room.test.ts / element-move-rotate.test.ts','physical: move; registered command native regression'],
 ['element.paste','copyElements','copy_elements','copy-elements.test.ts / copy-array.test.tsx','physical: paste'],
 ['element.array','arrayElements','array_elements','copy-elements.test.ts / copy-array.test.tsx','physical: array'],
 ['element.move','transformElements','edit_element_geometry: transform/move','physical-edit.test.ts / element-move-rotate.test.ts','physical: move'],
 ['element.rotate','transformElements','edit_element_geometry: transform/rotate','physical-edit.test.ts / element-move-rotate.test.ts','physical: rotate'],
 ['stair.place','addStair','run_flow: stair','stair-railing.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts','placement: stair'],
 ['railing.place','addRailing','run_flow: railing','stair-railing.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts','placement: railing'],
 ['split.multi','splitElements','edit_element_geometry: split (batched targets)','element-split.test.ts / multi-split.test.tsx / physical-edit.test.ts','physical: split; native batch invariants'],
 ['element.pushPull','setElementSize / transformElements','edit_element_geometry: size / transform','element-transform-size.e2e.test.ts / element-push-pull.test.tsx','physical: size / move'],
 ['element.align','alignElements','edit_element_geometry: align','align-native.test.ts / store-adapter-native-align.test.ts / element-align.test.tsx','align: all six modes, distinct shifts'],
 ['curtainwall.place','addCurtainWall','place_curtain_wall','design-place.test.ts / curtain-wall-grid.e2e.test.ts','placement: curtain-wall'],
 ['grid.place','addGrid / addColumnOnGrid','place_grid / place_grid_column','design-place.test.ts / grid-column.e2e.test.ts','placement: grid / grid-column'],
 ['element.trimExtend','trimExtendElement','edit_element_geometry: trim_extend','element-trim-extend.test.ts / physical-edit.test.ts','physical: trim'],
].map(([command,sdk,mcp,tests,browser])=>({command,sdk,mcp,tests,browser,finalAcceptance:'Source-bound behavioral evidence recorded; merge acceptance requires current-head gates, complete feedback and predecessor landings'}));
assert.equal(rows.length,24);assert.equal(new Set(rows.map(row=>row.command)).size,24);
const metadata={
  "issue": 6232,
  "charter": "Frozen original 24 modelling commands; source-only gap map c47, not the later main command registry",
  "exclusions": [
    "SpaceEnvelope #6686 is a separate landed feature",
    "Duplicate is a copy-route follow-up, not a 25th frozen command",
    "Inspector size/defaults/profile and ChangeSet/history are cross-cutting acceptance controls"
  ],
  "captureState": "Latest source-bound WSL Chrome evidence is indexed under room-input-forward: two fresh Room one/two-model receipts at clean 977846c5b3aac7b70a397d0e166acdc3019a2c99 after the strict SDK Update ID boundary repair, plus six retained Physical/Align/Placement receipts at genuine clean e98a99244ecc3f5a86968c485774a77f8845ae66 after the quantity/Align repairs. The unchanged audit verifies all 8 receipts, 184 stages and 436 native/displayed witnesses. Verified matching runtime remains de89ff1bf7178f644e6b6ad30159c765c28a4452483b687a58c2e17ae8be08e3; no new Rust build or other-suite browser run is claimed. Intervening semantic loopback main #6786 is separately qualified at clean ea1eac30b2c4b26eb356c739c42a2e23e2dfe09f under loopback-main-forward. Subsequent native-wire-deadline qualification changes one test scheduling deadline only; production source and actual capture labels remain unchanged. All original source/runtime labels and scope limitations remain preserved.",
  "alignRegisteredNativeProof": "Registered-command native controls and six-mode SDK browser controls passed; fresh clean e98a99244ecc3f5a86968c485774a77f8845ae66 Align receipts preserve distinct target shifts and one/two model contexts.",
  "mergeAcceptanceConditions": [
    "All preceding stack layers must actually land on main",
    "All four latest required current-head PR contexts must actually succeed and complete fresh feedback must be addressed",
    "Actual-main merge trees must match reviewed qualified source immediately before each merge"
  ]
};
const matrix={...metadata,rows};
fs.writeFileSync(path.join(dir,'acceptance-matrix.json'),JSON.stringify(matrix,null,2)+'\n');
let md='# #6232 frozen 24-command acceptance matrix\n\nThis is a review checklist, not a completion receipt. The original finite charter contains the following 24 commands. Later main SpaceEnvelope (#6686) is outside this charter. Ordinary placement uses the existing public `run_flow` nodes and shared SDK cores. Duplicate and inspector dimensions are cross-cutting follow-ups.\n\n';
md+=`${metadata.captureState}\n\nMerge acceptance requires predecessor landings, all four actual current-head required gates, complete fresh feedback and reviewed merge-tree identity. The test-only Copy deadline and surviving-writer witness are recorded separately under \`../copy-stress-deadline/\` and \`../copy-revert-witness/\`. Test names identify behavioral controls; they do not assert that an unrecorded final-head run occurred.`;
md+='\n\n| Command | SDK route | MCP route | Behavioral controls | Browser producer |\n|---|---|---|---|---|\n';
for(const row of rows)md+=`| ${row.command} | ${row.sdk} | ${row.mcp} | ${row.tests} | ${row.browser} |\n`;
md+='\nEvery final receipt must identify the exact source commit, loaded fixture hash and fetched WASM hash, show actual owning-model native meshes including origins, verify whole exported IFC graph/geometry Undo and unchanged peer state in one and multiple loaded models. Align native tests additionally cover source variants, per-root joined/hosted ownership and stale preparation. Browser six-mode receipts use two targets requiring different shifts. Room native MCP controls qualify Auto/Footprint/Update/Drag/Remove/Prune; this browser producer claims only Query/Pick/cut. Source metamorphic IFC4X3/mm variants are not independent authoring-tool fixtures.\n';
fs.writeFileSync(path.join(dir,'acceptance-matrix.md'),md);
