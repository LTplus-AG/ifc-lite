---
"@ifc-lite/pointcloud": minor
"@ifc-lite/viewer": minor
---

Fix LAZ loading + add PLY / PCD as standalone formats; sliders feel
responsive on first contact.

**LAZ silently failed to load.** `laz-perf` is shipped as CommonJS,
which Vite/webpack wrap under `.default` differently across builds.
The previous probe only checked `lazPerf.createLazPerf` and
`lazPerf.default` (as a function), so all real-world LAZ loads threw
"could not find createLazPerf factory". The probe now walks four
candidate shapes (named export, `default.createLazPerf`, `default` as
function, namespace-as-function) and reports the visible keys when
none match.

**PLY + PCD now load directly.** Two new streaming sources backed by
the existing format decoders:
- `PlyStreamingSource` — ASCII + binary little/big-endian, optional
  RGB (uchar) + intensity. Header probe (64 KB) + whole-file decode.
- `PcdStreamingSource` — wraps `decodePcd` (already supported PCD
  ASCII / binary / binary_compressed via inline LZF).

Both use stride downsampling for the host's 25M-point cap.

**Format detection** sniffs `.ply` (magic "ply"), `.pcd` (`# .P` or
`.PCD` token), and the existing `.las/.laz` paths.

**File picker** accepts `.ply` and `.pcd` in browser drop, the native
dialog, and the recent-files command palette.

**Slider UX.** Default size mode is now `fixed-px` (was `attenuated`).
The previous default felt inert because the slider in `attenuated` mode
is the upper *cap* on adaptive sizing — at typical wide views the
projected world-radius sat well below the cap, so dragging the slider
1↔20 px never engaged. `fixed-px` always uses the slider value, and
"Auto" is one click away when users want adaptive behaviour.

**Worker URL fix.** `worker-client.ts` now imports
`./decode-worker.ts` (matching geometry's pattern) so Vite's worker
plugin resolves through the source-alias path. The package's build
script post-rewrites that to `.js` for dist consumers.

Tests: 41 pointcloud unit tests pass (7 new for PLY ascii/binary +
header probe + truncation), full repo typecheck (24/24), full test
suite (22 runs green), viewer Vite build emits the decode-worker
chunk correctly.
