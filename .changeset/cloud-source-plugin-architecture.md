---
"@ifc-lite/plugin-api": minor
---

Adds the cloud source plugin architecture. `@ifc-lite/plugin-api` is a dependency-free type surface (`FileSourceProvider`, `PluginContext`, `PluginManifest`, and related types) that third-party file-source plugins implement against, so a provider can be written and versioned without depending on the viewer.

Architecture originally by @bruadam in #1761, where it shipped alongside a Dalux Build provider. This change lands the contract, the host and the UI on their own; the providers follow in their own PRs (`@ifc-lite/source-dalux`, then `@ifc-lite/source-msgraph`), so each gets a reviewable diff instead of one 127-file drop.
