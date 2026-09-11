---
"@ifc-lite/extensions": patch
"@ifc-lite/viewer": patch
---

Bound how long a bundle test's `expect.regex` matcher can run instead of leaving it unbounded on whatever thread calls it. `runBundleTests` now accepts an optional `evaluateRegex` hook; the viewer wires it to a Worker with a timeout so a pathological pattern that slips past the existing length-cap and shape-heuristic guards terminates instead of hanging the main UI thread, reachable via "Run tests" and the repair queue's "Run check". CLI and existing callers are unaffected — omitting the hook keeps the prior synchronous, in-process check.
