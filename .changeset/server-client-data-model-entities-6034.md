---
"@ifc-lite/server-client": minor
---

`ParseRequestOptions` gains `dataModelEntities: 'all' | 'rooted'` (#6034). `'rooted'` asks the server for a data model whose entities table carries only the objects (rows with a GlobalId) and the instances other tables reference, leaving out the geometry and property plumbing that makes up most of the table on large models. `fetchDataModel(cacheKey, options)` now also accepts an options object (`{ maxRetries, dataModelEntities }`), so the parse call's options can be passed straight through; the numeric `maxRetries` form still works. Use the same value on the parse and the fetch: the two variants are separate server cache entries.
