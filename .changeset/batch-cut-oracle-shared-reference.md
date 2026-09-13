---
"@ifc-lite/wasm": patch
"@ifc-lite/server-bin": patch
---

The batched opening cut's volume check now reads the host and the cut result about the host's one reference point. It used to read each about its own bounding-box centre, so on a host with an open crack, a batch whose cut moved the bounding box carried the crack's reading into the removed volume, and a correct batch could be rejected for the slower per-opening fallback.
