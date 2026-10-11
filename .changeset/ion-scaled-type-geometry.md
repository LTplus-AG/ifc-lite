---
"@ifc-lite/wasm": patch
---

Cesium ion compatibility export with a map scale other than one (for example UTM 0.9996) no longer refuses models whose type products carry `RepresentationMaps` that no occurrence instantiates. Each such map is wrapped at type level with the same scale: it keeps its ID and owner, and its authored origin and representation move into a scaled inner map. An instance with an identity mapping target, or one written in the exported coordinates, lands on the authored map coordinates; a target copied with a translation from the original file is off by that translation times one minus the scale. A type map nested inside another uninstantiated one, or nested too deeply to leave room for the type-level wrapper and an instance, still refuses. This unblocks infrastructure models such as ACCA's Viadotto Acerno bridge.
