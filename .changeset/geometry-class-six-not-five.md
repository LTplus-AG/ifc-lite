---
"@ifc-lite/geometry": patch
---

Correct the call-site count in `geometry-class.ts`'s docblock and its test's: six files across three packages compared `geometryClass` against bare integers before the module existed, not five.

The sixth is `apps/viewer/src/components/viewer/ViewportContainer.tsx:819`, which read `(meshes[i].geometryClass ?? 0) !== 0` and now goes through `meshIsNonOccurrence`. It was converted on #3161 and named in that PR's changeset and merge subject, but the two doc comments kept the pre-audit number — and they are what a reader lands on when opening the module. Comment-only; the enumeration now lists all six.
