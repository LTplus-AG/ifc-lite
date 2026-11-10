---
"@ifc-lite/clash": major
"@ifc-lite/cli": major
"@ifc-lite/sdk": major
"@ifc-lite/sandbox": major
"@ifc-lite/mcp": minor
---

Include model-qualified matched objects in rule coverage so object quality gates count federated models without conflating equal GlobalIds.

Keep clash findings for distinct objects whose exporter repeated a GlobalId, while preserving self-pair suppression for geometry parts sharing the same source object reference.

Breaking change: clash IDs involving repeated GlobalIds now include entity references to distinguish those objects. Comparisons against runs saved with the previous IDs may report resolved and added findings; establish a new baseline after upgrading. Ordinary identifiers retain their previous IDs; reserved-prefix and whitespace-containing keys, model IDs and rule IDs are escaped to prevent collisions.

Tag and escape ambiguous identities so literal keys cannot collide with reference-qualified keys. Repeated-key endpoints carry `keyAmbiguous`; review decisions and element-pair exclusions distinguish their entity references, and portable analysis runs preserve and validate that marker. Decisions for ambiguous objects require renewal if their references are renumbered. `clashElementIdentity` exposes the same decision key to integrations.

The SDK review adapter uses these keys for finding lineages and revision comparison. SDK consumers must also establish a new clash baseline after upgrading; the SDK release is major for this behavior change.

CLI JSON, MCP clash rows, and sandbox `bim.clash` results also expose the changed IDs. Their releases carry the same compatibility migration (major for CLI and sandbox; minor for the pre-1.0 MCP package). Re-establish baselines and stored ID-based references after upgrading these integrations.
