---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

The global instance plan (`perf.globalInstancing`, off by default) can be ramped. A host can set `GeometryProcessor.globalInstancing` to its own decision for the plan (for example a staged rollout) and hear each worker-pool load's decision through `onGlobalInstancingDecision`; `globalInstancingApplies` is exported. The worker pool decides the plan once per load, so a flag that changes mid-load cannot split the pre-pass request from its columns. The viewer resolves the flag for its own load processor (global, URL param, then the `perf-global-instancing` PostHog flag), reports the pool's decision as the telemetry arm, and still joins the keyed records of a snapshot cached under the plan for a user outside the ramp.
