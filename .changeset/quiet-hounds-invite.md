---
'@ifc-lite/ids': patch
---

Compare a `partOf` parent's `predefinedType` case-sensitively, as the entity facet already does

The IDS XSD gives the `partOf` facet's nested `<entity>` the same complex type an entity facet uses, but the two checkers each wrote out their own copy of the `<predefinedType>` matching rule and the copies had drifted: `entity-facet.ts` compared case-sensitively (enum tokens are uppercase by the IFC schema, and the buildingSMART corpus case `entity/fail-user_defined_types_are_checked_case_sensitively` requires an `IfcWall` carrying `ObjectType = 'waldo'` to fail a facet asking for `WALDO`), while `partof-facet.ts` passed a case-insensitive option on every branch. One and the same (raw enum token, user-defined name, IDS literal) triple therefore got opposite verdicts depending on which facet asked, and a `partOf` requirement whose literal differed from the model only in casing wrongly PASSED.

The rule now lives once, in `facets/predefined-type-match.ts`, and both facets consume its verdict; each still owns only its own failure wording. The diagnostics-free applicability twin `entityFacetPasses`, which held a third copy, calls it too.

No public API change.
