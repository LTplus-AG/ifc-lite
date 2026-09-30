# Supporting evidence archive for #6516

This stack preserves the supporting records that are too large or historical
for the implementation review. The implementation PR keeps the corrected
geometry qualification, provenance, census, native Revit changed-part data,
perf ledger, and a 100-row projection of the primary browser/native timing
pairs. This archive adds the corresponding raw timing logs, process host-load
observations, bounded controls, historical release comparisons, and corrected
surface-distance working material.

The primary browser host-load observation was a single 185,629-byte JSONL file
whose GitHub diff API omitted its patch. In the first archive PR it is stored in
numbered line-boundary shards under `supporting-browser-host-load/`; the
manifest records the original digest and each shard digest, and concatenation
reconstructs the exact original bytes. The compact paired timing projection
keeps the original raw-log digests.

The additional records in this commit retain the initial A/A, held AC20 A/A and
A/B controls, older release comparison, first-divergence trace, surface-distance
oracle outputs, invocations, reproduction method and full per-part verdict.
They are supporting diagnostics. The implementation PR's documented browser
verdict remains too noisy to establish overall speedup or neutrality.
