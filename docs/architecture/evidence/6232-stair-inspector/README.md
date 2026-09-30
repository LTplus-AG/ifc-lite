<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Selected stair dimensions: native viewer proof (#6232)

Captured on 2026-09-30 in native T3 tab `tab_7`, serving frozen source `4383c470d976df1deeeab676cfa9485056ef01af` at `localhost:5201`. The served WASM SHA-256 matched `5fbc315fb686b9a89f49c5c118d3cdec9646763109b14f73b3b078050b8aec13` (9,377,364 bytes). These files describe that source; adding evidence does not constitute a later source retest.

The unmodified public Bonsai sample `apps/viewer/public/samples/hello-wall.ifc` was supplied through the viewer's file input and canonical load path: 79,592 bytes, SHA-256 `0ab20f4ea355ea9aa4fade7264b97ee9f9929addfa3961b2437c4381bd674014`. The new stair was authored by the actual viewer Stair tool with native viewport clicks, then selected as flight #10048, parent #10047. Bonsai supplied the wall and windows; it did not supply this flight.

Native typing followed by Enter changed Width from 1.00 to 1.40 m, RiserHeight from 0.175 to 0.20 m, TreadLength from 0.5960670291156602 to 0.65 m, and WaistThickness from 0.15 to 0.20 m. Every edit changed the real rendered triangle positions. The 16 risers stayed fixed; the rendered rise changed from 2.8 to 3.2 m. The waist edit changed the underside geometry while preserving the bounds.

Four native Undo button clicks each restored the preceding complete serialized scene owner. The fourth restored the initial scene owner exactly. Four native Redo clicks each restored its corresponding edited scene owner; the fourth restored the final edited state exactly. The wall #1222 and windows #1262/#1407 remained byte-equal as serialized scene owners throughout all 13 observations. The history record counts in [facts.json](facts.json) count internal records, not user actions: each inspector action contributes 50 records in one Undo batch, while the original Stair creation contributes 58. Undo remains available for that creation after undoing the four edits.

The scene hook reports world-placed triangle corners in viewer Y-up coordinates, resident part metadata, an instance flag and the projected screen centre. `cornersHash` hashes the actual triangle positions; `flatMetadataHash` hashes part metadata. The complete owner comparison includes those fields and screen position. These hooks do not establish identity of GPU upload bytes, normals or full vertex/index buffers. The separate real WASM tests cover complete physical geometry and shared source/style preservation.

A preceding attempt through Start blank exposed the existing missing engine-coordinate-frame refusal: authored geometry could not be remeshed. No frame was patched, and that attempt is excluded from the physical proof. This separate finding remains tracked under the open #6232 charter.

- [Initial authored flight](initial.png)
- [All four dimensions edited](edited.png)
- [Initial state restored by four Undo clicks](undo-restored.png)
- [Edited state restored by four Redo clicks](redo-restored.png)
