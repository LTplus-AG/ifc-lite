---
"@ifc-lite/renderer": patch
---

Release CPU geometry fully: `releaseGeometryData` and the end of ephemeral streaming now drop the cached placed copies of each mesh. Those copies share the source's typed arrays, so they kept released geometry alive.
