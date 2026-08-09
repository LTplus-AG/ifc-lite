---
"@ifc-lite/source-dalux": patch
---

Run the shared `FileSourceProvider` conformance suite against `DaluxBuildProvider`, over a mock of the Dalux Build REST API (`@ifc-lite/source-fixture/conformance`, added as a dev dependency). No runtime code changes: this adds the test wiring the kit was written for but never had.

Three of the kit's assertions had to be corrected first, because each failed a provider that behaves exactly as the plugin contract specifies. `ListOptions.limit` is documented as a hint, and Dalux's bookmark pagination takes no page-size argument, so the "a real page boundary forces cursor-following to work" check — which forced boundaries by passing `limit` and then counting requests — failed `listProjects`, `listContainers` and `listFiles` on a correct provider. And `RevisionWatchResult.cursor` is optional, documented as what providers with a delta endpoint return, yet the suite required one from every provider declaring `changeDetection`; Dalux polls and correctly returns none. The third is the mirror of that one: the suite asserted unconditionally that `watchRevisions` reports no events for an empty ref list, but the contract tells a delta-backed provider to ignore `refs` and read its cursor, so that assertion rejected a correct change-feed provider and is now scoped to polling providers.
