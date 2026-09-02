---
'@ifc-lite/bcf': patch
---

Emit the schema-required `<ExtensionSchema>` in BCF 2.1 `project.bcfp`.

BCF 2.1's `project.xsd` declares `<ProjectExtension>` as the sequence `Project?`, `ExtensionSchema` — and `ExtensionSchema` carries no `minOccurs`, so it is required. `writeProjectFile` never emitted it, so every BCF 2.1 archive this package produces shipped a `project.bcfp` that fails validation against the official schema with `Element 'ProjectExtension': Missing child element(s). Expected is ( ExtensionSchema )`. That is every archive in practice: 2.1 is `createBCFProject`'s default and every caller in this repository takes it, and `createBCFProject` always sets a project id, so `project.bcfp` is always written. It is now emitted as an empty `<ExtensionSchema/>`, which is a valid `xs:anyURI` and the honest value — this writer ships no `extensions.xsd`, so there is no extension schema to name. BCF 3.0 is unaffected: its `project.xsd` has no `ExtensionSchema` element at all, and none is written there.

A new `interop-conformance.test.ts` validates every entry of an archive assembled only through the public helpers — `createBCFProject`, `createBCFTopic`, `createBCFComment`, `createViewpoint`, the sequence the viewer's BCF panel, `@ifc-lite/cli` and `@ifc-lite/mcp` all follow — against the vendored buildingSMART XSDs, and fails if any entry fails. The existing schema tests only validated a hand-built maximal fixture, and the `project.bcfp` violation had been pinned there as an accepted gap rather than fixed.
