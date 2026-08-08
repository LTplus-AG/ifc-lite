---
"@ifc-lite/mcp": patch
---

Fix `descriptor.limit` / `descriptor.offset` in the read backend (`backend-query.ts`) silently ignoring a non-numeric, negative, or `Infinity` value instead of rejecting it. `descriptor.offset && descriptor.offset > 0` (and the equivalent for `limit`) is falsy for `NaN` — every comparison with `NaN` is false — so a caller that computed a bad value from e.g. `Number(userInput)` got back every matching row instead of an error, silently returning more than it asked for. The same falsy-zero shape made `limit: 0` ("no rows") a no-op instead, silently returning every row.

No built-in MCP tool reaches this today: `query_entities` validates `limit`/`offset` as JSON-Schema integers before its handler runs and paginates separately via its own `paginate()` helper rather than the query builder's `.limit()/.offset()`. The live path is the public SDK surface — `HeadlessLikeBackend` is exported from both `./index.js` and `./browser.js` for embedders, and driving it through `@ifc-lite/sdk`'s fluent `QueryBuilder` (`bim.query().limit(n).offset(m).toArray()`) reaches `descriptor.limit`/`descriptor.offset` directly, unguarded by any tool schema.

`entities()` now throws on a non-finite or negative `limit`/`offset` instead of quietly serving the wrong slice. `limit: 0` is now a deliberate empty result rather than being silently ignored — a behaviour change, not just a bugfix, and nothing in this package uses `0` as an "unlimited" sentinel.

Same defect shape as the CLI's `headless-backend.ts` fix (#2298); `packages/mcp` has its own parallel implementation of this adapter (not a shared import), with its own tests and release cadence, so it needed its own fix.
