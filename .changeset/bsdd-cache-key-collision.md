---
'@ifc-lite/sdk': patch
---

Fix `bim.bsdd.fetchClassInfo` and `bim.bsdd.fetchClassByUri` serving each
other's cached result for the same URI.

Both methods shared one `Map<string, ...>` cache keyed only by URI, but they
disagree on what a URI's entry means: `fetchClassInfo` (IFC dictionary
classes) always marks its `classProperties` `isIfcStandard: true` and
requests class relations; `fetchClassByUri` (any dictionary, including
non-IFC ones like Uniclass/OmniClass) always marks them `false` and does not
request relations. Nothing in the cache key recorded which method wrote an
entry, so whichever method ran first for a given URI silently answered every
later call to the *other* method for that same URI — wrong `isIfcStandard`
flags and missing `relatedIfcEntityNames`, with no network request to catch
it.

The cache key is now namespaced per method (`std:` / `any:`), so an entry
written by one method can never be read by the other.
