---
"@ifc-lite/pointcloud": patch
"@ifc-lite/viewer": patch
---

Near-term batch — correctness + robustness items from #611.

**`computeBBox` empty / non-finite guards.** Both `e57.ts` and
`ifcx-points.ts` now return `{0,0,0}/{0,0,0}` for empty arrays and
skip non-finite triplets. Previously a zero-point or NaN-poisoned
chunk produced ±Infinity bounds that broke camera fit-to-view and
section-plane sliders.

**Magic-byte-first format detection.** `detectPointCloudFormat` now
probes the buffer (E57 magic, LASF magic, "ply" / "#" / ".PCD"
ASCII tokens) before falling back to extension. A LAS file
mistakenly named `*.ply` no longer goes down the wrong decoder. LAS
vs LAZ still uses the extension to disambiguate (they share the
LASF magic).

**E57 packet-bounds + per-stream guards.** Validate that the
DataPacket header, bytestream-length table, and each individual
bytestream stay inside `payloadEnd = packetEnd - 4` before reading.
Corrupt files now fail with a precise "bytestream X runs past
packet payload" error instead of silently reading into the next
packet.

**`e57.ts` split (631 → 4 files).** `e57-page.ts` (header / page CRC
/ section-header resolver), `e57-xml.ts` (prototype + Data3D
parser), `e57-decode.ts` (per-scan binary decoder), `e57.ts`
(orchestrator + re-exports). All four under the AGENTS ~400-line
guideline.

**`point-cloud-renderer.ts` extract.** Pulled the uniform-block
writer into `point-cloud-uniforms.ts` (`writePointCloudUniforms` +
mode index maps). Renderer drops below 400 lines.

Verified: 62 pointcloud unit tests pass, full repo typecheck
(24/24).
