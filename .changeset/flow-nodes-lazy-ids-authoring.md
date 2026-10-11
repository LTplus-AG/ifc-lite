---
'@ifc-lite/flow-nodes': patch
---

The `ids.load`, `ids.lint` and `ids.validate` flow nodes now load `@ifc-lite/ids-authoring` on first run instead of at import, so hosts that register the standard node set (like the viewer) no longer pull the IDS authoring core into their startup bundle. Node ids, ports, params, outputs and error messages are unchanged.
