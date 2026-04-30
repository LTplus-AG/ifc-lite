---
"@ifc-lite/pointcloud": minor
"@ifc-lite/viewer": minor
---

E57 reader (subset) + clear errors when users drop unsupported formats.

**E57 (ASTM E2807-11) reader.**
- 48-byte FileHeader parser (`ASTM-E57` magic + xmlPhysicalOffset/Length
  + pageSize).
- Page-CRC stripping: every 1024-byte physical page ends with 4 bytes
  of CRC32-C; we strip them to get the logical view that XML offsets
  reference. CRCs aren't validated (faster + still correct on
  well-formed files).
- XML parser via `DOMParser` walks `e57Root → data3D → vectorChild` and
  extracts each scan's record count, binary fileOffset, and prototype
  fields.
- Binary section decoder walks DataPackets, reads bytestream length
  table, decodes uncompressed Float32 / Float64 cartesianX/Y/Z plus
  optional Float colors and Integer u8 colorRed/Green/Blue.
- ScaledIntegerNode encoding throws a clear error so the host can guide
  the user to a Float-encoded export.

**Drop UX.** Dropping a file we can't load (Recap `.rwp/.rwi/.rwcx/.dmt`,
`.skp`, `.zip`, Faro `.fls`, ASCII `.pts/.xyz`) now shows an
explanatory toast describing what the format is and what to do
(typically: "export to E57 / LAS / PLY"). Previously the drop was
silently rejected.

**File picker** accepts `.e57` in browser drop, the native dialog, and
the recent-files command palette.

7 new pointcloud unit tests cover the FileHeader parser, page-CRC
stripping (full pages and partial trailing page), the binary packet
walker on a hand-built single-packet scan with Float64 cartesianX/Y/Z
+ uint8 RGB, and the ScaledInteger error path.

Tests: 48 pointcloud unit tests pass, full repo typecheck (24/24),
test suite green (22 runs), viewer Vite build emits decode-worker
chunk correctly.
