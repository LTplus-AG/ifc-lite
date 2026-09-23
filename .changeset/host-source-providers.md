---
"@ifc-lite/viewer": minor
"@ifc-lite/plugin-api": patch
---

A host application that builds the viewer from source can now register its own file-source providers at build time: call `mountViewer(root, { sourceProviders: [() => new MyProvider()] })` from `apps/viewer/src/bootstrap.tsx` in its own entry. Each factory is constructed and registered independently, after the built-ins, through `SourceHost.register()`, so version, duplicate-name and relay checks apply unchanged, and a provider that throws or is refused is listed in the Sources panel as failed to register without affecting any other provider. The plugin-api README documents the seam.
