---
"@ifc-lite/viewer": minor
---

Model tags for federations (#4215, part 1): create, rename, assign and bulk-edit free-form tags on the models of a federation from the hierarchy model row; a `modelTag` advanced-filter rule (`has any` / `has all` / `has none` / `untagged`) shared by search and clash set filters; a tag that a saved rule names but no longer exists is shown as unresolved and matches nothing (search) or refuses the run (clash) instead of silently widening; clash runs resolve tag membership from one snapshot and flag results whose tag inputs changed since; the portable federation setup file (format 2) carries tag definitions and assignments, and still reads format 1.
