---
"@ifc-lite/server-client": minor
"@ifc-lite/data": minor
"@ifc-lite/ids": patch
---

IDS validation on server-parsed models now matches candidate values for multi-valued properties (enumerated / bounded / list / table), for INSTANCE-attached properties, identically to the in-browser path (#1766). The server emits the same `values[]` candidate array `parsePropertyValue` produces — enumerated/list members, bounded lower/upper/setPoint (deduped), table defining-then-defined values — as a JSON-encoded nullable `values_json` column (data-model cache v4 → v5, sparse: only multi-value rows). The decoder parses it, `convertServerDataModel`'s `materializeProp` attaches it to the property entry, and the existing IDS bridge (`projectProperty` → facet `candidateValues`) consumes it unchanged, so a facet passes when the constraint matches ANY candidate (not just the joined display value). `@ifc-lite/data`'s `Property` gains an optional `values?: string[]`.
