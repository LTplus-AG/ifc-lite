---
"@ifc-lite/viewer": patch
---

React commit counts per load (#6957): under `?perfTrace=1` the viewer counts every React commit as the `react.commits` load counter, read from the DevTools global hook (chained onto an installed React DevTools hook, or a minimal one installed before react-dom loads), because React's production build never calls `<Profiler onRender>`. Adds `scripts/perf/hook-census.mjs`, a static count of hook call sites and viewer-store subscriptions on the viewport, properties, hierarchy and streaming paths.
