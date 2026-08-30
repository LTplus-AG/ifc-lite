---
'@ifc-lite/mutations': patch
---

`MutablePropertyView.getForEntity` no longer duplicates a brand-new property onto every base property set that shares its `name`. Traced from the viewer's bSDD "jump to added property" highlight (#1107): an entity can carry two distinct `IfcPropertySet`s with the same `Name`, and `setProperty`'s mutation key carries no identity past that name, so adding a property new to both wrote it into both — a genuine duplicate in `getForEntity`'s output, not just a display ambiguity. It now lands on only the first same-named instance, matching the "first match wins" semantics `findPropertyInSets`/`PropertyTable.getProperty` already use for same-named reads (#3468). `packages/mutations/test/mutable-property-view.duplicate-pset.test.ts` pins the fix; a companion viewer test (`PropertySetCard.same-name-focus.test.tsx`) confirms the existing highlight logic now lands on exactly the mutated pset once the data stops duplicating.
