---
"@ifc-lite/cli": minor
"@ifc-lite/ids-authoring": minor
---

`ifc-lite ids diff <before.ids> <after.ids> [--json|--md]` compares two IDS revisions semantically and exits 1 when they differ. Specifications and facets are paired by the re-identification cascade (identifier, then name and applicability, then similarity), so a rename or an edited requirement reads as one change. `ifc-lite ids explain <rules.ids> [--lang en|de|fr] [--md]` prints every specification in plain language.

`@ifc-lite/ids-authoring` exports the diff behind it as `diffIds(before, after)`, returning `IdsDiffEntry[]` (added / removed / changed, with the XML path, before and after values and one plain-language line).
