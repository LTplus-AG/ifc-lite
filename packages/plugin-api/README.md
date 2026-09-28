# @ifc-lite/plugin-api

Dependency-free type surface for ifc-lite file-source plugins (CDE integrations).

Plugins implement `FileSourceProvider` and declare a `PluginManifest`. The host
(the ifc-lite viewer) loads providers, auto-generates settings UI from the
manifest's `preferences` array, and injects a sandboxed `PluginContext` at
runtime.

See the [architecture docs](https://ifclite.dev/docs/) for the full design.

## Commit-aware sources (contract 2.1.0)

A provider can describe models as a chain of **immutable commits** instead of
(or alongside) files with revisions. It opts in by declaring
`capabilities.commits`; a host then lists a model's commits, loads any one of
them, and — without transferring the model file at all — reads per-element
fingerprints, a stored diff between any two commits, and one element's history
across re-GUIDs.

Everything about it is additive. Every commit member is optional on
`FileSourceProvider`, each is present exactly when its capability flag is
`true`, and a provider declaring `^2.0.0` that has never heard of a commit
registers and behaves exactly as before.

```ts
if (sourceProvider.manifest.capabilities.commits) {
  const commits = await sourceProvider.listCommits!(ctx, { projectId, modelId });
  const payload = await sourceProvider.loadCommit!(ctx, { projectId, modelId, commitId: commits.items[0]!.id },
    { accept: ['ifc-step', 'ifc-zip', 'ifcx'] });
  // payload.artifactDigest is `sha256:<hex>` over the original bytes — verify
  // it before loading, or a service that served the wrong commit's bytes is
  // indistinguishable from one that served the right ones.
}
```

Errors carry a `code` from a fixed union rather than a shared base class, so a
host branches on `isCommitSourceError(err) && err.code === 'conflict'` without
knowing which provider threw. `@ifc-lite/source-fixture/conformance`'s
`runCommitConformanceSuite` checks an implementation against the whole
contract; `@ifc-lite/source-commit-http` is a generic implementation over a
documented REST API.

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
