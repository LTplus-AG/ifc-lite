---
"@ifc-lite/ids-authoring": minor
---

New `@ifc-lite/ids-authoring` package: the headless IDS authoring core. It covers `StudioDocument`, which gives every IDS node a stable UUID, and the typed operation vocabulary v1. Ops are validated at runtime and exported as JSON Schema for AI tools. A pure reducer with exact inverses applies them, including compound bulk ops. The grounding gate checks entity, predefined type, attribute, property set, property, enumeration and data type names against the per-version IFC schema tables and returns ranked candidates. The package also provides history, transactions and a persistence adapter interface, the `studio.json` sidecar and `.idsz` bundles, re-identification of externally edited IDS, and plain-language facet descriptions.
