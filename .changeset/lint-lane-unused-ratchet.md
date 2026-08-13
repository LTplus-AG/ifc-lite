---
"ifc-lite": patch
---

The Lint CI lane now checks something.

Root `lint` was `pnpm -r lint`, and no package defined a `lint` script — so the lane matched nothing, exited 0, and reported pass in about twenty seconds having run no linter at all. With no ESLint config in the repo and `noUnusedLocals` disabled, nothing caught unused code: twelve imports left pointing at code that had moved sailed through a green Lint check in #2601.

`scripts/check-unused-locals.mjs` is a ratchet rather than a flag flip, because turning on `noUnusedLocals` today would mean 953 violations across 46 packages and a sweep that is its own change. It counts the "declared but never read" diagnostics per package and fails when any package exceeds its committed baseline. Fifteen packages sit at zero and must stay there; the rest can only shrink. `pnpm lint:baseline` rewrites the baseline after a genuine cleanup.

Two details worth knowing. It counts the whole unused family, not just `TS6133` — `TS6192` ("all imports in this declaration are unused") is the dead-import case itself, and missing it made `apps/viewer` unmeasurable, which is precisely where those twelve imports were. And a package in the baseline that stops compiling is reported as a failure rather than silently dropped, so breaking a build cannot become a way to lose the guard.
