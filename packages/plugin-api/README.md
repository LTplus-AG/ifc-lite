# @ifc-lite/plugin-api

Dependency-free type surface for ifc-lite file-source plugins (CDE integrations).

Plugins implement `FileSourceProvider` and declare a `PluginManifest`. The host
(the ifc-lite viewer) loads providers, auto-generates settings UI from the
manifest's `preferences` array, and injects a sandboxed `PluginContext` at
runtime.

See the [architecture docs](https://ifclite.dev/docs/) for the full design.

## Registering your own provider in a viewer build

The viewer registers its built-in providers (Dalux, Dropbox, Microsoft 365)
itself. A host application that builds the viewer from source can add its own
`FileSourceProvider` implementations at build time, without patching viewer
source: point the build's entry at a file of your own that calls the viewer's
`mountViewer` (in `apps/viewer/src/bootstrap.tsx`, which is all the stock
`main.tsx` does) with `sourceProviders`.

<!-- docs-check: skip -->
```ts
// Your entry, used in place of apps/viewer/src/main.tsx.
import { mountViewer } from './bootstrap';
import { AcmeProvider } from '@acme/ifc-lite-source';

mountViewer(document.getElementById('root')!, {
  sourceProviders: [() => new AcmeProvider()],
});
```

Each entry is a factory. The viewer constructs and registers each one on its
own, after the built-ins, through the same `SourceHost.register()` path the
built-ins use:

- A manifest whose `api` does not satisfy `PLUGIN_API_VERSION`, a name that is
  already registered (a built-in's included), or an undeclared relay route is
  refused.
- A factory that throws is caught.
- A refused or failed provider is listed in the Sources panel as "failed to
  register" with the reason. It never stops the built-ins or any other
  provider from loading.
- A registered provider gets the same sandboxed `PluginContext` as a built-in:
  https-only fetch to its declared `permissions.network` domains, no ambient
  credentials, no redirects, bounded retries, and storage namespaced by
  `manifest.name`.

This is build-time composition only. The viewer loads no provider code at
runtime, and `.iflx` extensions get no new capabilities from it.
