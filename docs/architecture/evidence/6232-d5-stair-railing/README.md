# D5 stair/railing and atomic replacement evidence (#6232)

Current local provider qualification (2026-10-03) is retained in
`public-provider-be0068.json.gz`: 109 raw log/result payloads with byte
counts, SHA-256 and recoverable `contentBase64`. Its behavioral source is
`be0068ecce9bf06d80d3ffc69fde2814fa4e9921`. The own root build and generated API
ran on `e01b1495ad04fba090544f8c3acc049c505774c1`; the current head differs only
in the test consumer declaration, with identical production, runtime and API bytes.

The mounted real `BimProvider` first failed both single-model and federated
controls because its backend lacked the canonical writer. Passing the full viewer
store fixes that public boundary. The same controls now commit real Bonsai stair
graphs/native flight meshes, preserve refused edits and undo the assembly pair.
The first RED and the later nested-function lint failure are both preserved.

Actual current runs: 111 root typecheck tasks and all 3,330 test files, 75
passing controls across seven affected entrypoints, and all 13 repository gates.
The official inverse collected all 75: reverting production gave 47 passes and
28 real assertion failures, zero loading failures, and verified restoration.
Two existing CLI entrypoints remain passing under the broad revert; the other
five observe it. The own production build passed all 62 tasks.

These are mounted DOM and Node/WASM controls. Current browser screenshots and
remote CI are pending; the synchronous remote backend still requires async
implementation. Full D5, public Space integration and the #6232 charter remain open.

## Historical qualification (2026-10-02)

`qualification.json.gz` contains a JSON record and 38 retained log/result/patch
payloads, each with its byte count and SHA-256. Decode `contentBase64` to recover
the original bytes. The committed public Bonsai `hello-wall.ifc` fixture's
header, byte count and hash identify the real authoring-tool input.

The qualified source is `83b386205b52ac649d291ace76c06b6333259b65`, based on
`5e15a26e4b807008adfc03ccc22a13e79844373b`. Publication adds current main
`2323207641c8858426faa029ed024ff28ae6685e`; all 30 feature and 103 incoming
paths are disjoint and retain their exact blobs. This source union needs fresh
CI/runtime qualification before readiness; interactive browser proof is pending.
The deletion-channel gate inventory now names the extracted mesh-stash helper;
the unchanged single-deleted-ID exemption passes the real gate and 63 gate tests.

Actual runs: 62 build tasks, 111 typecheck tasks and all 3,311 test sources;
52 CLI cases; 1,396 create cases plus 13 explicit optional fixture skips;
45 existing viewer consumers without skips; root lint and 431 compiled docs.
The default CI inverse collected all six changed test entrypoints: 67 passes
became 47 passes and 20 assertion failures, with restoration verified.
Separate rebuilt inverses establish atomic refusal: create 11 → 3 passes,
SDK 2 → 0 passes and flow 52 → 48 passes, then full original passing counts.

Real WASM meshes, exported schema attributes/relationships, metre/millimetre
frames, one/two-model isolation and compound Undo are asserted in the tests.
These are Node/WASM runs, not a GPU/browser performance claim. D5 and the full
charter remain open; this layer adds stair/railing capabilities and fixes the
tracked replacement/removal class without completing the remaining capability lanes.
