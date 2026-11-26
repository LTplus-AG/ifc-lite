---
"@ifc-lite/geometry": patch
"@ifc-lite/viewer": patch
---

Out-of-core geometry ingest can be ramped through PostHog (`perf-ooc`) and stays off by default. `GeometryProcessor` and `processParallel` take the host's decision for one load (`outOfCore`; unset, the explicit `?perf.ooc` / `__IFC_LITE_OOC`) and report whether that load's pool meshed out of core (`onOutOfCoreDecision`). The viewer hands the ramp to the first attempt of its own primary load only (a federated add and a resource retry follow the explicit flag alone), and the `perf_flags` telemetry arm reports what the current primary load's pool ran: a small file, a cache or server load, or a file the arena cannot serve reports off.
