---
"@ifc-lite/export": minor
"@ifc-lite/cli": minor
---

Add an anonymized isolated export: pick a seed selection, expand it by relationship context, and export exactly that subset as a STEP file with every project-identifying signal removed.

`@ifc-lite/export` gains `collectRelatedEntities(store, seeds, options?)`, which walks host/opening/filler, aggregate parent/child, type, material, spatial-containment and (bounded) connected-element relationships outward from a seed selection, and `exportAnonymizedSubset(store, includedIds, options?)`, which exports that subset with root placements zeroed (rotations kept), georeferencing/addresses removed, names pseudonymized (`IfcRoot` text fields via `pseudonymizeNames`; `ObjectType`, `Phase` and non-`IfcRoot` names such as surface styles, materials, layers and profiles via `pseudonymizeAllNames`), `GlobalId`s regenerated, property sets dropped, owner history scrubbed (persons, organizations, dates, the authoring tool's version string and the header's `originating_system`), and `IfcMonetaryUnit.Currency` neutralized to USD — every toggle defaulting to the maximally-scrubbed direction. Only the spatial containers the selection actually sits in are exported; sibling storeys are not pulled in through the building. See the new `RelatedEntityOptions`/`RelatedEntities`/`AnonymizeOptions`/`AnonymizeResult` types and the "Anonymized isolated export" section of the exporting guide.

`@ifc-lite/cli` gains `ifc-lite anonymize <file.ifc> --out F`, selecting objects by `--id`/`--guid`/`--type`/`--storey`, with flags to tune the relationship expansion (`--no-hosts`, `--no-openings`, `--no-types`, `--no-materials`, `--no-aggregates`, `--connect-depth`), `--keep-psets` / `--keep-names` / `--keep-other-names` / `--keep-currency`, and a `--guid-map` sidecar file for the old→new `GlobalId` mapping.

The viewer's Export menu gains a matching "Anonymized" dialog laid out beside the live 3D view (the objects about to be exported are isolated and highlighted), with a category overview to block whole IFC classes, uniform Anonymize/Keep switches for every scrub (all on by default), and a prompted download name that is never derived from the model's name.
