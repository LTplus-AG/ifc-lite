---
'@ifc-lite/mcp': patch
---

Fix `model_diff` reporting a re-exported model as `modified · data` on every measure-propertied element when only the project's declared length/area/volume unit changed — the same fix as `@ifc-lite/cli`'s `ifc-lite diff --by-content`, applied to both the stored-entity and the overlay-created (`entity_create`) fingerprint paths, which this server's adapter is a documented byte-for-byte twin of.
