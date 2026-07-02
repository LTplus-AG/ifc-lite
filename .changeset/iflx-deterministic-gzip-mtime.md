---
"@ifc-lite/extensions": patch
---

Pin the gzip MTIME header to 0 in `packBundle` so `.iflx` bytes are deterministic for the same input. Previously the header embedded wall-clock seconds, so re-packing identical content in a different second produced a different content-addressed bundle hash (and flaked the determinism test). Matches the fix already shipped in the flavor packer.
