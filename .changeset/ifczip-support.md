---
"@ifc-lite/parser": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

feat(parser): support opening `.ifcZIP` containers (issue #1494)

The buildingSMART IFC container format — a zip archive wrapping a single
`.ifc`/`.ifcxml` file — is now unwrapped transparently. New `@ifc-lite/parser`
exports:

- `isZipBuffer(buffer)` — cheap magic-byte check.
- `unwrapIfcZip(buffer)` — returns the model file's bytes if `buffer` is a
  zip container, or `buffer` unchanged otherwise (safe to call
  unconditionally on every load). Throws if the archive has zero or more
  than one `.ifc`/`.ifcxml` entry rather than guessing which to load, or if
  the entry's declared uncompressed size exceeds 4 GiB (a zip-bomb guard,
  checked from the zip central directory — no decompression needed to check).
- `unwrapIfcZipView(view)` — same contract for a Node `Buffer`/`Uint8Array`.

`parseAuto` calls it automatically. The CLI and MCP loaders (`loadIfcFile`,
`loadIfcModel`) unwrap before their STEP-signature check, so `ifc-lite info
model.ifcZIP` and MCP's `model_load` just work. The viewer's file picker and
drag-and-drop now accept `.ifczip` alongside `.ifc`/`.ifcx`/`.glb`; its server
fast-path (which uploads the original `File`, not the in-memory buffer) is
skipped for a `.ifcZIP` source and falls through to the local WASM path,
which does consume the unwrapped bytes — the server itself has no zip support.

Referenced resources inside the container (textures, documents) are not
extracted in this pass — only the model file's bytes.
