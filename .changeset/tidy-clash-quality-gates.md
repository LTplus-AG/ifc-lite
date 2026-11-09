---
"@ifc-lite/clash": major
"@ifc-lite/cli": patch
"@ifc-lite/sdk": minor
---

Include model-qualified matched objects in rule coverage so object quality gates count federated models without conflating equal GlobalIds.

Keep clash findings for distinct objects whose exporter repeated a GlobalId, while preserving self-pair suppression for geometry parts sharing the same source object reference.

Breaking change: clash IDs involving repeated GlobalIds now include entity references to distinguish those objects. Comparisons against runs saved with the previous IDs may report resolved and added findings; establish a new baseline after upgrading. Ordinary identifiers retain their previous IDs; reserved-prefix and whitespace-containing keys, model IDs and rule IDs are escaped to prevent collisions.

Tag and escape ambiguous identities so literal keys cannot collide with reference-qualified keys. Repeated-key endpoints carry `keyAmbiguous`; review decisions and element-pair exclusions distinguish their entity references, and portable analysis runs preserve and validate that marker. Decisions for ambiguous objects require renewal if their references are renumbered. `clashElementIdentity` exposes the same decision key to integrations.
