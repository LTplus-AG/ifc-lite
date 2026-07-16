---
"@ifc-lite/plugin-api": minor
"@ifc-lite/source-dalux": minor
---

Adds the cloud source plugin architecture: `@ifc-lite/plugin-api` is a dependency-free type surface (`FileSourceProvider`, `PluginContext`, `PluginManifest`, and related types) that third-party file-source plugins implement against, and `@ifc-lite/source-dalux` is the first such plugin, a Dalux Build (Box) provider (listProjects/listContainers/listFiles/testConnection/checkRevisions) built on that surface.
