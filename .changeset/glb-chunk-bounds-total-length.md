---
'@ifc-lite/export': patch
---

Fix `parseGLB` (and everything built on it — `countGlbMeshes`, `extractGlbMapping`, `parseGLBToMeshData`) walking chunks past the GLB header's declared `total` length instead of stopping there.

The loop bound was the raw buffer's `byteLength`, not the header's validated `total` field, and a chunk's own declared length was never checked against that total before slicing. Two consequences of a malformed or tampered buffer:

- Bytes appended after a structurally valid GLB (a phantom chunk shaped with its own length prefix and the `BIN\0`/`JSON` magic) got parsed as a genuine trailing chunk and silently REPLACED the real JSON/BIN chunk — the file, structurally, still looked fine to iterate, so it never threw.
- A chunk whose declared length overran the header's `total` relied on `Uint8Array.subarray` silently clamping to a truncated view rather than a thrown error.

Both now throw (`GLB chunk extends beyond declared length: ...`) instead of returning a decoded GLB built from data outside its declared bounds. This mirrors the bounds check the sibling GLB reader in `@ifc-lite/cache` already has. A well-formed GLB — the only shape any of our own exporters or WASM assemblers produce — is unaffected.
