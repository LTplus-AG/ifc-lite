---
'@ifc-lite/cli': minor
---

`ifc-lite flow <run|describe|validate>`: evaluate a `*.flow.json` node graph headlessly with the standard `@ifc-lite/flow-nodes` library — Player-style `--input` overrides, `--out` to write the model with the run's mutations, a describe schema for callers, a per-node availability report, and a `<graph>.tracking.json` sidecar so re-runs of tracked creation graphs update elements instead of duplicating them.
