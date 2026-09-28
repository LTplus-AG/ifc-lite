---
"@ifc-lite/viewer": patch
---

Parsing starts sooner after opening an IFC file ([#6431](https://github.com/LTplus-AG/ifc-lite/issues/6431)). The full-content identity used to match saved workspace placements was computed by re-reading the whole file in 1 MiB slices before parsing could begin, although the loader already held the file in memory. It is now hashed from those bytes. The chunking and digest are the same, so the identity is identical and saved placements still match.
