---
"@ifc-lite/viewer": patch
---

BCF viewpoint capture of an isolate that mixes IFC entities with viewer-only ones (point clouds, synthetic ids, unregistered models) now records the entities it can name and tells the author how many it could not, instead of silently writing an allowlist that reads as "the others were hidden". An isolate with no nameable member is still omitted rather than written as "nothing visible", and a genuinely empty isolate still records an empty allowlist. An isolate that includes an entity of a model whose metadata is still loading is refused for the moment (component omitted, author told to retry) rather than recorded as hidden. A hide-list shortfall only under-hides, so it is logged, not toasted. The capture decision lives in `hooks/bcf/visibility-capture.ts`.
