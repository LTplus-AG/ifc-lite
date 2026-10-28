---
"@ifc-lite/extensions": minor
---

Layer authority, step 2 of the authority spec (`docs/architecture/layer-prs/12-authority.md`). `parseCharter` validates an `ifclite::authority` responsibility map: roles mapped to principals, and rules mapping attribute selectors such as `model.mutate:Pset_WallCommon.FireRating@IfcWall*` to a role. Two equally specific rules that can govern the same attribute for different roles are rejected as `ambiguous_authority`. `findGoverningRule` picks the most specific rule for an attribute. `resolveAttribute` is the pure §12.5 resolution: given an attribute's opinions, it returns the state (`agreed`, `divergent`, `unconfirmed`, `authority-split`, `contested` or `authoritative`), the opinion to show, and the dissenting opinions. Also available from `@ifc-lite/extensions/authority`.
