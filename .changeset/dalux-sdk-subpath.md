---
'@ifc-lite/source-dalux': minor
---

Add `@ifc-lite/source-dalux/sdk`: every Dalux Build endpoint group — tasks, forms, users, companies, work packages, inspection plans, test plans, project templates — with zod-parsed responses, from `dalux-build-api/web`.

`createDaluxSdk(client)` borrows the library's endpoint catalogue but not its transport: it drives this package's own `BrowserDaluxApiClient`, so the same-origin relay routing, `daluxNode` selector, byte-exact handling of signed download links and `ctx.log` tracing all still apply. Writes throw `DaluxReadOnlyError` rather than being dropped, since the provider is read-only.

It is a separate subpath on purpose. `DaluxBuildProvider` is statically imported by the viewer, and the catalogue costs zod plus its schemas, so nothing here is reachable from the package's main entry — prefer a dynamic `import()`. The provider's own request paths are unchanged and keep their hand-written decoders.
