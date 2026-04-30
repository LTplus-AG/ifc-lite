---
"@ifc-lite/pointcloud": patch
---

E57: read the 32-byte CompressedVector section header before walking
DataPackets.

Per E57 spec §6.4.2, every CompressedVector binary section starts with
a 32-byte header (sectionId + reserved + sectionLogicalLength +
dataPhysicalOffset + indexPhysicalOffset) BEFORE the first DataPacket.
The XML's `points@fileOffset` points at that section header, not at
the packets.

The previous decoder walked packets straight from `points@fileOffset`,
so the first byte (sectionId == 1) was misread as packetType (1 ==
data — coincidentally also valid), and the u16 at offset 4 was the
low half of `sectionLogicalLength`, which decoded as `bytestreamCount
= 0`. That produced the user-reported error
`bytestreamCount (0) ≠ prototype length (7)` on every real-world E57.

New `resolveCompressedVectorDataOffset` reads the section header,
validates `sectionId == 1`, and follows `dataPhysicalOffset` to the
actual logical packet start. `decodeE57` now applies it to every
entry before passing through to `decodeE57Scan`.

3 new tests cover: correct dataPhysicalOffset translation, wrong
sectionId rejection, and out-of-bounds section header rejection.
