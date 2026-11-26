---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

The global instance plan (`perf.globalInstancing`, off by default) can be ramped. `setGlobalInstancingRamp` lets a host supply a staged-rollout value that applies when neither the global nor the URL param is set, and the viewer binds it to the `perf-global-instancing` PostHog flag. The worker pool now decides the plan once per load, so a ramp value that arrives mid-load cannot split the pre-pass request from its columns. A user outside the ramp still joins the keyed records of a snapshot cached under the plan.
