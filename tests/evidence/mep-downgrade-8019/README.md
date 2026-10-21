# MEP occurrence downgrade (#8019)

At source `9b3dfd1347`, the browser harness ran the public TypeScript
`StepExporter` and native WASM `exportStep`, then reopened both IFC2X3 outputs
through the canonical `buildPrePassOnce` / `processGeometryBatch` path.
`browser-result.json` retains the complete mesh populations and duct records.
All three authored products (#50 wall, #51 slab, #52 duct) survived with the
independently specified bounds, 12 triangles and 6 m³ per product.

The source-built WASM SHA-256 was
`ef7c2dee0ef6977166fc6258f5b1428249ad4c9f1047e733622734c968206f43`.
The build began at `17c074a71d`; its Rust/toolchain inputs are identical at
`9b3dfd1347`. Pop, Node 24.22.0, pinned nightly 2025-11-15. Browser:
T3 server-headless Chromium, GPU disabled by launch flag. This evidence
covers actual browser WASM execution, not WebGPU rendering.

A temporary in-memory negative control removed only `IFCDUCTSEGMENT` from
`MEP_IFC2X3_TYPES`, exported through the same public TypeScript facade, and
reopened the result: mesh IDs were exactly `[50, 51]`. Record #52 became an
`IfcProxy` with a replacement GlobalId and no placement or representation.
The mapping was restored in `finally`; production source was not mutated.
This conclusively identifies the missing duct independently of section export.

IfcOpenShell 0.9.0.post1 independently validated the IFC4 source and both
actual exporter outputs with `express_rules=True`: zero issues across three
files (`schema-oracle.txt`). Its own geometry engine also confirmed all three
products, each at the authored world bounds and 6 m³, for the source and
TypeScript output. The source fixture is deliberately small and authored;
this is not a real-authoring-tool corpus claim.

To reproduce, build dependencies from the repository root with
`pnpm build --filter=@ifc-lite/export`, start Vite from the repository root
(`node apps/viewer/node_modules/vite/bin/vite.js --port 5189`), then open
`/tests/evidence/mep-downgrade-8019/browser.html` and click the export button.
Use the repository's machine admission wrapper for builds and services.
The automated regression is `schema-mep-geometry.test.ts`; the existing
IfcOpenShell conformance lane also validates the fixture and conversion.
