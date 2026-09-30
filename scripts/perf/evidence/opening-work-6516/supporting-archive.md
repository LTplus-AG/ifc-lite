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


`historical-precorrection-qualification.json` preserves the old `current-v3-independent-qualification.json` bytes (SHA-256 `898fe864e21283de21f320dab5cb1c0122684320b16d94937cc14355ef166bf6`) under an explicitly historical name. It uses the superseded pre-correction codelog hashes and surface distances; do not cite it as current qualification. The primary PR's corrected nine outputs and reproducer are authoritative for the finite surface qualification.

`browser-aa-v3-report.json` is a same-build A/A control. Its AC20 `realChange: true` is a noisy control observation and does not establish a branch regression.

`native-parts-verdict.json` uses the historical pre-correction helper `a61d8d45…`, also recorded in `historical-precorrection-qualification.json`. Its surface distances are superseded by `surface-review-correction/native-rvt14-changed-parts.json` and the corrected nine reports under `surface-review-correction/`. Its measured values are retained unchanged.
