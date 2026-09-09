---
"@ifc-lite/viewer": patch
---

The Lists panel's "Run" and "Import" actions caught a failure and only `console.error`-ed it — the spinner stopped and nothing on screen said why, which reads identically to a genuine empty result. This became user-reachable once `compileNameMatcher` started throwing on a ReDoS-guard-rejected `/regex/` name-pattern column instead of falling back silently.

`ListPanel` now tracks a `listError` store field (mirroring `SearchModal.filter.tsx`'s `searchFilterError`) and renders a dismissible "List failed" banner — reusing the same visual treatment as the advanced filter's `FilterErrorBox` — for both a rejected run and a rejected import file. A genuinely empty result set (zero matches, or every cell `null`) still clears the error and publishes an ordinary result; only a caught exception sets it.

`ListPanel.tsx` was also split: its List Library / List Item sub-components moved to a new `ListLibrary.tsx`, keeping the file under the module-size budget after the error-surfacing addition.
