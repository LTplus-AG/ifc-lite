---
"@ifc-lite/wasm": patch
---

Cesium ion compatibility export with a map scale other than one (for example UTM 0.9996) no longer refuses models whose type products carry `RepresentationMaps` that no occurrence instantiates. Each such map is wrapped at type level with the same scale: it keeps its ID and owner, and its authored origin and representation move into a scaled inner map, so an instantiation lands on the authored map coordinates. A type map nested inside another uninstantiated one still refuses. This unblocks infrastructure models such as ACCA's Viadotto Acerno bridge.
