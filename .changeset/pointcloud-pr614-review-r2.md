---
"@ifc-lite/pointcloud": patch
"@ifc-lite/viewer": patch
---

Round 2 of CodeRabbit feedback on PR #614:

- **E57 stride downsampling drops classifications.** `applyStride` rebuilt
  positions / colors / intensities into new arrays but never copied the
  per-point class IDs, so any non-default stride (`{ stride: 2 }` and up)
  silently lost them and `hasClassification` flipped to false.
- **Federation abort can stomp a newer load.** The AbortError handler in
  `useIfcFederation.addModel()` wrote `progress`, `error`, and `loading`
  unconditionally — if a second `addModel()` started after the first was
  cancelled, it lost its spinner and progress to the cancelled load's
  cleanup. Added a `loadSessionRef` token (mirrors `useIfcLoader`) and
  gate state writes on `loadSessionRef.current === currentSession`.
- **E57 Integer classification subtracts `minimum`.** Class IDs are
  absolute labels (ASPRS LAS 1.4 0..31), not range-normalised offsets.
  `raw - minimum` was corrupting class IDs whenever a producer declared
  a non-zero `minimum` on the Integer-encoded classification field. The
  Integer branch now matches the ScaledInteger branch's intent: keep
  the raw byte, clamp to 0..255.
- **PCD probe missed `VERSION` / `FIELDS` headers.** The magic-byte
  detector only recognised `# .PCD …` comment-style headers. Real PCDs
  emitted by PCL's `pcl_io` and a few third-party tools start directly
  with `VERSION 0.7\n…` or `FIELDS x y z\n…` — these now route through
  the PCD decoder instead of falling through to extension-based
  detection (which would mis-route a renamed PCD).
- **Catch-block logging.** Per repo convention, log point-cloud ingest
  failures in `useIfcLoader.ts` before the early return so abort vs.
  real-failure vs. stale-session paths are distinguishable in console
  triage.

Test cleanup: drop the shadowed (and unused) ScaledInteger packet
buffer in `e57.test.ts` so only the live `fullBuf` setup remains.
