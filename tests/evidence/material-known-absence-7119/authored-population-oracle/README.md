# Independent authored selection population oracle (#7119)

The earlier expectation recomputed the same relationship helper used by the selection adapter, so dropping authored edge #51 left all 21 tests green. This test-only correction expects the five relationships authored for slab #52 in the tracked SketchUp building-architecture IFC fixture, plus zero classifications (the only classification relation #36 applies to building #30).

Source qualification was run on frozen main ae27edc77b596700595ce0fc13f03e416af179c2 with candidate test SHA 2a32bb6b86f2856be83f9a4f5aa24e152063bc2b0db54da418583a184b2efeee. Source commit a42e73cd54 carries that exact test delta. No production helper mutation is shipped.

Actual root Turbo controls: old test with one canonical relationship removed, 21/21 green; new literal oracle with the identical loss, 20 pass/1 genuine assertion failure (4 versus 5); exact original production restored, 21/21 green. Plain full root typecheck covered all 3,735 test files across 62 packages. All eight light gates passed.

The qualification manifest records 25 raw/gzip pairs. Only compressed logs/receipts are committed; decompression reconstructs the recorded raw bytes and SHA256. Runtime witnesses retain actual test-process start/exit hashes: test controls used b335…, while later typecheck produced 8b742…. These are separate observations, with no native or performance claim. Root independently verified source, fixture anchors, archive integrity and actual reporter counts.

Refs #7119. This bounded oracle repair does not establish every issue acceptance condition or close the issue.
