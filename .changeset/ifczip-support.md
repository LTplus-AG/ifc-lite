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
  than one `.ifc`/`.ifcxml` entry rather than guessing which to load.

`parseAuto` calls it automatically. The CLI and MCP loaders (`loadIfcFile`,
`loadIfcModel`) unwrap before their STEP-signature check, so `ifc-lite info
model.ifcZIP` and MCP's `model_load` just work. The viewer's file picker and
drag-and-drop now accept `.ifczip` alongside `.ifc`/`.ifcx`/`.glb`.

Referenced resources inside the container (textures, documents) are not
extracted in this pass — only the model file's bytes.
