---
"@ifc-lite/wasm": minor
"@ifc-lite/cli": patch
---

Add optional retained-only GPU instancing for byte-identical rigid mapped products.
Retained reports identify candidate instance groups from `instanceKey`; remove the
unused raw `RetainedShapeProduct.instanceGroup` field. OBJ keeps all occurrences baked.
Retained-only bounds and first-frame updates use the loaded source kernel; exact
loads keep their existing shard drain, camera fitting, and milestone timing.
