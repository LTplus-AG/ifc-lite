---
"@ifc-lite/geometry": patch
---

Give small, compute-bound IFC files more geometry workers on active-cooled
(10+ core) machines. The per-core caps were tuned to a bandwidth ceiling
measured on a >512 MB georef result, but small models (e.g. a 20 MB
boolean-clipped steel file) are CPU-bound, not bandwidth-bound — the 3–4
worker cap left most cores idle. Files ≤64 MB now scale to `cores-2` workers
(memory budget and `?geomWorkers=N` override still apply).
