---
"@ifc-lite/parser": patch
---

Avoid Firefox stalls while publishing large-model metadata by keeping entity-cache eviction linear across scans and preparing georeferencing and source fingerprints in the parser worker.
