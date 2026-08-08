---
"@ifc-lite/ids": patch
---

Fix a false FAIL on `partOf` requirements whose nested `entity.predefinedType` constraint asks for the literal `USERDEFINED` token against a parent that also carries a custom name.

`getAncestors` sourced `ParentInfo.predefinedType` from `getObjectType`, which collapses a `USERDEFINED` raw enum to the accompanying user-defined name (e.g. `ObjectType`/`ElementType`). A spec requiring predefinedType `USERDEFINED` on the parent then compared that literal against the custom name instead of the raw token, and failed — even though `entity-facet.ts`'s direct entity check accepts exactly this case via its raw-token-first, user-name-fallback match.

`ParentInfo` now carries the raw `PredefinedType` token separately from the user-defined name (`objectType`), and `partof-facet.ts`'s predefinedType match mirrors `entity-facet.ts`'s two-branch logic: raw token first, falling back to the user-defined name only when the raw token is `USERDEFINED`.
