---
"@ifc-lite/bcf": patch
---

Fix two ways `createBCFFromIDSReport` could drop IDS validation failures from the exported BCF file with no trace:

- A specification that fails on cardinality alone (its applicability matched zero entities and `minOccurs` required at least one — e.g. a required element type entirely missing from the model) produces an empty `entityResults`. The `per-entity` (default) and `per-requirement` grouping strategies iterate `entityResults` to build topics, so this kind of failure never became a topic at all: the validator correctly counted the specification as failed, but the exported BCF file showed nothing for it. Both strategies now emit a topic for a cardinality-only failure, the same way `per-specification` grouping already did.
- `maxTopics` (default 1000) cut generation off with a bare early return in all three grouping strategies, silently dropping the remaining entities/specifications/requirements past the cap. `MAX_COMMENTS_PER_TOPIC` already handles its own, narrower truncation (comments within one topic) with an "... and N more" note; `maxTopics` now gets the same treatment via a synthetic `Info` topic recording how many further items were cut off.
