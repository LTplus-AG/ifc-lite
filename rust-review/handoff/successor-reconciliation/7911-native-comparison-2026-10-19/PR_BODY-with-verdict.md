## Summary

For tessellated `IfcPolygonalFaceSet`, refuse a face whose referenced entity record is missing and continue processing the remaining face entries. Valid faces retain their authored geometry, and the existing typed refusal path reports the unsupported face. Other decode errors continue to propagate; this change does not invent geometry or change shared-coordinate, face-list, or index validation policy.

References #7779 for tracking; this supporting PR does not auto-close the issue.

## Evidence

- Independent source review of candidate `c08456df48462344a93cd84dd84cc72c4d7930dc` found no remaining blocker. The baseline RED and source-only inverse observations are preserved as local observations.
- Ordinary admitted worker `c8e48539-cd84-49a9-aee9-f901c1a9f219` on `pop-os` (2 CPUs, 8 GiB), using the explicit candidate checkout and reused candidate target: focused router tests 10/10 passed; native `process_geometry` tests 2/2 passed; exact `cargo clippy --workspace --all-targets -- -D warnings` exited 0.
- All 182 fixture entries passed size and SHA-256 verification before and after the worker run. Source was clean and unchanged before/after at the pinned commit/tree and file hashes.
- The preserved earlier direct-local full workspace log reports 5,468 passed, 0 failed, 47 ignored, but that run was unadmitted and its original terminal exit status is unavailable. It is not claimed as worker-qualified or as an exit-0 workspace run.

Worker receipt and focused logs are preserved at `/home/louistrue/.t3/artifacts/ifc-issue-resolution-bc9e57fa/f3b-polygonal-face-leftover/worker-verification/`; the earlier local run remains under `qualification/logs/`.

## Measured comparison and verdict

Exact BASE `1bd0505602e0d650971d5cdc590bf780c56f8d5f` versus production head `f04d4f621e2dd0b168ef298e116a25a827161995`: admitted Pop worker `c72bb237-d907-453b-92b7-b96ab2c116fd` completed all six prepared commands, five internal observations each, with clean unchanged sources and original binary/fixture identities. Admission observed 98.1% idle and 55 C before the worker's own guards. Managed benchmark admission held exclusive ownership for the measured cohort; no competing managed jobs were present at admission.

| Fixture | Best-selected parse delta | Geometry delta | Total delta | All-sample median total, base -> branch |
| --- | ---: | ---: | ---: | ---: |
| Haus | -7.7% | -9.5% | -5.9% | 34 -> 37 ms |
| ISSUE_129 | +5.9% | +2.0% | +2.1% | 3616 -> 3690 ms |
| Holter | -3.9% | +19.2% | +10.7% | 2378 -> 2374 ms |

**Verdict: timing is inconclusive; no speedup or performance-neutrality claim.** The existing producer selects phase statistics by minimum total. Holter's fastest BASE sample diverges from its median, while the small Haus samples have broad spread; medians are context, not a substituted passing protocol. All raw totals and complete native process-geometry wall arrays are retained. These are warm native observations, not a full worker-pool/browser/cold-load measurement. Broader charter performance obligations remain open.

**Output identity:** all five ordered mesh fingerprints per side match for all three fixtures, with identical entity/mesh/vertex/triangle counts and existing CSG-failure/degenerate counters. This fingerprint scope does not cover text/material definitions, UV/texture or instancing. No unexplained mesh-output difference was accepted.

[Original commands, raw arrays, fingerprints, worker receipt and preserved setup failure](https://github.com/LTplus-AG/ifc-lite/blob/75c5c03c02cf955707fd309e3fa92360b4ebe284/rust-review/handoff/successor-reconciliation/7911-native-comparison-2026-10-19.json). The initial saved recipe referenced removed worker checkout paths; the launch failed before job registration or workload. Only those paths were rebound to already-existing clean worktrees at the same commits/trees; binaries, driver bytes, fixtures, ordering and measurement protocol were preserved.

## Final checks

The prior production head passed all four required contexts and the hosted performance ratchet. Head `859501aed3f6446432841d05c5d6f743a8377eb3` adds only the required narrative verdict in `scripts/perf/README.md`; production/test code is byte-identical to the measured and qualified head. Final required checks on this documentation head gate the merge. No worker-qualified local full-workspace rerun, worker-pool performance improvement, wider Rust charter completion or #7779 closure is claimed.
