# D5 stair/railing and atomic replacement evidence (#6232)

`qualification.json.gz` contains a JSON record and 34 retained log/result/patch
payloads, each with its byte count and SHA-256. Decode `contentBase64` to recover
the original bytes. The committed public Bonsai `hello-wall.ifc` fixture's
header, byte count and hash identify the real authoring-tool input.

The qualified source is `83b386205b52ac649d291ace76c06b6333259b65`, based on
`5e15a26e4b807008adfc03ccc22a13e79844373b`. Publication adds current main
`2323207641c8858426faa029ed024ff28ae6685e`; all 30 feature and 103 incoming
paths are disjoint and retain their exact blobs. This source union needs fresh
CI/runtime qualification before readiness; interactive browser proof is pending.

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
