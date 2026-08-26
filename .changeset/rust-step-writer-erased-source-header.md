---
"@ifc-lite/wasm": patch
---

Stop erasing the source file's HEADER on a Rust-side STEP export.

`exportStep` (and the `ifc-lite export --format step` CLI that calls it) wrote a header built entirely from constants:

```
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','',(''),(''),'ifc-lite','ifc-lite-export','');
```

Two of those are wrong values rather than merely missing ones. The `FILE_DESCRIPTION` item is a model-view-definition claim, so a file authored against `ViewDefinition [CoordinationView_V2.0]` came back asserting a different MVD; and ISO 10303-21 gives `FILE_NAME`'s `time_stamp` as the file's creation date-time, which `''` is not. The author, organization, authoring system and authorization the source stated were dropped outright, so a round trip through the CLI erased the model's provenance.

The TypeScript writer `buildStepHeader` had preserved all of this since it was written; nothing held the two halves together, so the Rust port never gained it. It now reads the source header (a port of `parseSourceHeader`) and applies the same precedence field for field: an explicit option wins, else the source's value, else the documented default. `StepOptions` gains `filename` and `time_stamp`, and its four header strings become optional so "not stated" is expressible.

One documented difference remains: given no explicit stamp, the TypeScript half stamps the current time and the Rust half carries the source's stamp forward, because `SystemTime::now` is unavailable on the `wasm32-unknown-unknown` target this exporter ships to. Both agree whenever a caller states a stamp.

The halves are now pinned to shared cross-language vectors (`rust/export/tests/fixtures/step_header_vectors.json`), whose expectations are written from ISO 10303-21 and each case's own source file rather than from either implementation.
