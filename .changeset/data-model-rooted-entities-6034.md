---
"@ifc-lite/server-bin": minor
---

The data model can now leave out the STEP instances no client looks up (#6034). With `?data_model_entities=rooted` on `POST /api/v1/parse/parquet`, `/parse/parquet/optimized` or `/parse/parquet-stream`, the data model's entities table carries only the rooted entities (the ones with a GlobalId), plus every non-rooted instance another data-model table references by id, such as the materials and material sets the materials table names. Every id in the relationship, property, quantity, material, classification, document and spatial tables still resolves, those tables are byte-identical to the default payload, and `entity_id`s are unchanged. Fetch it with `GET /api/v1/parse/data-model/{key}?data_model_entities=rooted`, and pass the same parameter to `/api/v1/cache/check/{hash}`.

The rooted table is cached under its own key (`-datamodel-rooted-v8`), so a warm cache never serves one variant to a request for the other. Without the parameter, output and cache keys are unchanged.
