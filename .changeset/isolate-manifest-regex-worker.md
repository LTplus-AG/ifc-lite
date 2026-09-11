---
"@ifc-lite/extensions": patch
"@ifc-lite/viewer": patch
---

Bound how long a bundle test's `expect.regex` matcher can run instead of leaving it unbounded on whatever thread calls it. `runBundleTests` now accepts an optional `evaluateRegex` hook; the viewer wires it to a Worker with a timeout so a pathological pattern that slips past the existing length-cap and shape-heuristic guards terminates instead of hanging the main UI thread, reachable via "Run tests" and the repair queue's "Run check". CLI and other existing callers are unaffected — omitting the hook keeps the prior synchronous, in-process check.

A rejection that isn't a genuine invalid-pattern `SyntaxError` (a worker timeout, a disposed client, a worker that failed to start) now reports as "regex: evaluation failed", distinct from "regex: invalid pattern" — previously every such rejection was mislabeled as the author's pattern being malformed. In the viewer, if the regex worker itself can't be started (a CSP blocking module workers, or no `Worker` at all), `expect.regex` checks now fall back to the same synchronous in-process evaluation used before #4482, rather than failing every check; the pattern length cap and catastrophic-backtracking shape heuristic still run unconditionally before either evaluator, so that fallback loses only the timeout bound and main-thread eviction, not those guards.
