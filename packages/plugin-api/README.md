# @ifc-lite/plugin-api

Dependency-free type surface for ifc-lite file-source plugins (CDE integrations).

Plugins implement `FileSourceProvider` and declare a `PluginManifest`. The host
(the ifc-lite viewer) loads providers, auto-generates settings UI from the
manifest's `preferences` array, and injects a sandboxed `PluginContext` at
runtime.

See the [architecture docs](https://ifclite.dev/docs/) for the full design.
