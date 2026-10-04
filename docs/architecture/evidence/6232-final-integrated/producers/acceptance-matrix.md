# #6232 frozen 24-command acceptance matrix

This is a review checklist, not a completion receipt. The original finite charter contains the following 24 commands. Later main SpaceEnvelope (#6686) is outside this charter. Ordinary placement uses the existing public `run_flow` nodes and shared SDK cores. Duplicate and inspector dimensions are cross-cutting follow-ups.

Latest current-wasm-main-forward contains eight complete primary WSL Chrome receipts at actual1b49 source/a050 runtime (184stages/436native-displayed witnesses) and six registered preview/Escape contexts at helper-only730f source/same runtime (28stages). All original source/runtime labels and missing-view/native/commit scope distinctions remain literal. Subsequent actual-main fixed-clock and early-schedule qualification changes no modelling/Rust/runtime/capture bytes; source-bound types/MCP/viewer controls are archived separately. Historical capture and forward qualification text is retained under historicalCaptureState.

Merge acceptance requires predecessor landings, all four actual current-head required gates, complete fresh feedback and reviewed merge-tree identity. The test-only Copy deadline and surviving-writer witness are recorded separately under `../copy-stress-deadline/` and `../copy-revert-witness/`. Test names identify behavioral controls; they do not assert that an unrecorded final-head run occurred.

| Command | SDK route | MCP route | Behavioral controls | Browser producer |
|---|---|---|---|---|
| element.split | splitElements | edit_element_geometry: split | element-split.test.ts / physical-edit.test.ts | physical: split |
| wall.place | addWall | run_flow: wall | ordinary-element.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts | physical: authored-wall |
| wall.moveEndpoint | resizeWall | edit_element_geometry: wall_endpoints | element-transform-size.e2e.test.ts / physical-edit.test.ts | physical: endpoints |
| slab.place | addSlab | run_flow: slab | ordinary-element.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts | placement: slab |
| column.place | addColumn | run_flow: column | column.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts | align: column-a/column-b |
| beam.place | addBeam | run_flow: beam | beam.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts | placement: beam |
| room.place | roomCommand | room_command: query/auto/pick/footprint/update/edit | room-command.test.ts / room-place.test.tsx / room-layout.test.tsx | room: query/pick/cut; other modes native MCP |
| opening.place | addOpening | place_opening | hosted-place.test.ts / hosted-place.test.tsx | placement: opening |
| door.place | addHostedDoor | place_door | hosted-place.test.ts / hosted-place.test.tsx | placement: door |
| window.place | addHostedWindow | place_window | hosted-place.test.ts / hosted-place.test.tsx | placement: window |
| hosted.slide | editHostedElement | edit_hosted_element | hosted-place.test.ts / store-adapter-hosted.test.ts | placement: hosted-slide |
| plan.move | transformElements | edit_element_geometry: transform/move | store-adapter-native-physical-room.test.ts / element-move-rotate.test.ts | physical: move; registered command native regression |
| element.paste | copyElements | copy_elements | copy-elements.test.ts / copy-array.test.tsx | physical: paste |
| element.array | arrayElements | array_elements | copy-elements.test.ts / copy-array.test.tsx | physical: array |
| element.move | transformElements | edit_element_geometry: transform/move | physical-edit.test.ts / element-move-rotate.test.ts | physical: move |
| element.rotate | transformElements | edit_element_geometry: transform/rotate | physical-edit.test.ts / element-move-rotate.test.ts | physical: rotate |
| stair.place | addStair | run_flow: stair | stair-railing.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts | placement: stair |
| railing.place | addRailing | run_flow: railing | stair-railing.test.ts / flow-creation-native.test.ts / store-adapter.ordinary-live-view.test.ts | placement: railing |
| split.multi | splitElements | edit_element_geometry: split (batched targets) | element-split.test.ts / multi-split.test.tsx / physical-edit.test.ts | physical: split; native batch invariants |
| element.pushPull | setElementSize / transformElements | edit_element_geometry: size / transform | element-transform-size.e2e.test.ts / element-push-pull.test.tsx | physical: size / move |
| element.align | alignElements | edit_element_geometry: align | align-native.test.ts / store-adapter-native-align.test.ts / element-align.test.tsx | align: all six modes, distinct shifts |
| curtainwall.place | addCurtainWall | place_curtain_wall | design-place.test.ts / curtain-wall-grid.e2e.test.ts | placement: curtain-wall |
| grid.place | addGrid / addColumnOnGrid | place_grid / place_grid_column | design-place.test.ts / grid-column.e2e.test.ts | placement: grid / grid-column |
| element.trimExtend | trimExtendElement | edit_element_geometry: trim_extend | element-trim-extend.test.ts / physical-edit.test.ts | physical: trim |

Every final receipt must identify the exact source commit, loaded fixture hash and fetched WASM hash, show actual owning-model native meshes including origins, verify whole exported IFC graph/geometry Undo and unchanged peer state in one and multiple loaded models. Align native tests additionally cover source variants, per-root joined/hosted ownership and stale preparation. Browser six-mode receipts use two targets requiring different shifts. Room native MCP controls qualify Auto/Footprint/Update/Drag/Remove/Prune; this browser producer claims only Query/Pick/cut. Source metamorphic IFC4X3/mm variants are not independent authoring-tool fixtures.

Historical captures and forward qualifications: Latest source-bound WSL Chrome evidence is indexed under room-input-forward: two fresh Room one/two-model receipts at clean 977846c5b3aac7b70a397d0e166acdc3019a2c99 after the strict SDK Update ID boundary repair, plus six retained Physical/Align/Placement receipts at genuine clean e98a99244ecc3f5a86968c485774a77f8845ae66 after the quantity/Align repairs. The unchanged audit verifies all 8 receipts, 184 stages and 436 native/displayed witnesses. Verified matching runtime remains de89ff1bf7178f644e6b6ad30159c765c28a4452483b687a58c2e17ae8be08e3; no new Rust build or other-suite browser run is claimed. Intervening semantic loopback main #6786 is separately qualified at clean ea1eac30b2c4b26eb356c739c42a2e23e2dfe09f under loopback-main-forward. Subsequent native-wire-deadline qualification changes one test scheduling deadline only; production source and actual capture labels remain unchanged. Later channel-profile-review fixes structured-clone error reporting through one canonical helper and strengthens the real profile refusal oracle; integrated SDK336/profile6/native MCP38 pass. Its real-channel proof is separate from the retained browser source labels. The later mcp-revert-witness strengthens one existing native state-conflict assertion, with full official actual-base OBSERVED proof and verified restoration; new-route collection gaps remain explicit. All original source/runtime labels and scope limitations remain preserved. Subsequent Room preparation and lifecycle fixes, corrected full-source qualification and two fresh Room captures at actual 902684264034c676f82fd951b3609b1db65a3e97 are archived under [room-review-lifecycle](../room-review-lifecycle/). Its reproducible mixed-source audit retains the six earlier Physical/Align/Placement capture labels; no other-suite recapture is claimed. The later test-only native-preparation-budget archive records eight scoped 30-second native integration deadlines and fresh combined typecheck/ten-control qualification; assertions, production, API and original browser/oracle source labels remain unchanged.

## late Room Review

[Source-bound archive](../room-review-lifecycle/); source `6fcee10246506226f26fcb4381fecdb75a7869eb`.

Root types111/all3399, SDK341, mutations370, MCP637+2unrelatedskips, native viewer20, lint8492/API/module-size pass; original failures and corrected fixture preserved. Full official actual-main2e2 revert OBSERVED:327 baseline passes,36 attributed assertions in14 complete files, restoration verified;15 collection gaps remain explicit.

Only Room one/two-model captures are fresh at902684. Six Physical/Align/Placement receipts retain actual e98a992 labels. The unchanged archive auditor verifies8receipts/184stages/436native-displayed witnesses and peer state. Original source/runtime labels are preserved.


## native Preparation Budget

[Source-bound archive](../native-preparation-budget/); source `dc04b1ef80961ee9d372170c1dd9e76ca08bf7f2`.

Root typecheck: 111 successful tasks, 106 cached, all 3399 test files; exact native controls: 10 passed, zero skips/cache. Original CI deadline failures and inconclusive stale prerequisite diagnosis are retained. Earlier full-suite, browser and oracle runs retain their literal source labels.

Test-only finite 30-second per-case deadline for eight two-model native fault/recovery controls; two input-only controls retain default. Assertions, production, API and request/global deadlines unchanged.


## transform Preview

[Source-bound archive](../cold-transform-preview/); source `57cb2ed558ab9d4cbd6244063f2d796f9b71a64c`.

Six genuine native old-planner assertion failures become six fixed passes; root422a types111/all3401,viewer33,lint8494; main57cb types111/all3403,document130. Native/document controls zero skips/cache. Source/API/Rust/runtime identities and original failed attempts retained.

Six real WSL Chrome first-authoring registered Align/Move/Rotate preview/Escape-cancel one/two-model contexts,28stages, initialized empty view retained. Native missing-view behavior and independent-reference commit controls are separate; no browser missing-view or same-host commit claim. Historical eight-receipt/184-stage/436-witness audit remains unchanged.


## schedule Main Forward

[Source-bound archive](../schedule-main-forward/); source `6c4b1c5ca5f2d5af5cac67dfb15dde42121e0011`.

Root typecheck111/all3405/94cache; SDK341/parserSchedule59/sandboxSchedule12/viewerSchedule104 PASS0skip/cache; API9344/52pkgs/85surfaces and generatedBim14namespace freshness pass.

25 inherited actual-main scheduling paths; exact additive API/generated declaration union; modelling/Rust/runtime unchanged. Prior captures retain literal57cb/902/e98 source labels, no retake claimed.


## current Wasm Main Forward

[Source-bound archive](../current-wasm-main-forward/); source `1b49d7864c1debef03c9e3473452261169c611d5`.

Fallback-disabled fresh Rust build; SDK341/viewer31 zero skips/cache, WASM146/7optional skips all8owned contracts executed, Rust4438/39ignored, strict all-target Clippy. Root6c4 types111/all3405 remain literally source-bound; latest committed bindings unchanged. Fresh eight primary browser receipts pass unchanged strict audit8/184/436; six registered preview/Escape contexts pass28stages. Original failed/incomplete attempts preserved.

All8 primary contexts source1b49, all6 supplemental source730f helper-only serialization fix. Loaded empty view retained; canonical allocator1→9993 then unchanged. Missing-view native and independent-reference commit proofs separate. Inherited perf verdict neutral; no integrated gain claimed.


## fixed Clock Main Forward

[Source-bound archive](../fixed-clock-main-forward/); source `2ede141ce45b6ccc7f61fd538ddb98013664b129`.

Roottypes111/all3405/94cache actual0; fullMCP637/2unrelatedskips/70files/0cache actual0 pinnedA050 with maxWorkers2; assertions/deadlines/source unchanged. Limited initialcached-runtime run and failed fresh-default startup-deadline run preserved.

One inherited MCPtest fixed-clock helper substitution, full refusal/STEP equality assertions intact. Production/API/Rust/runtime/capture labels unchanged; no new browser/build/perfclaim.


## early Schedule Main Forward

[Source-bound archive](../early-schedule-main-forward/); source `ed68e240572316addc867de9be11548434e82bd2`.

Roottypes111/all3407/110cache actual0; affected viewerSchedule/chart490 zero fail/skip/cancel/cache actual0. Exactly13 mainpaths, packages/Rust/API/Bim/planner unchanged2ede; publishedown db35 composition matches qualifiedtree.

Viewer-only scheduling playback/date editing presentation; original14browser/source2edeMCP/1b49native labels retained. Runtime restoredbeforeviewer afterTurbo cache replay; no new capture/build/fullMCP/perfclaim.

