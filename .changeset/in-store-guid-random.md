---
"@ifc-lite/create": minor
---

Thread `@ifc-lite/encoding`'s `RandomSource` through the in-store builders: `SpatialAnchor.guidRandom` seeds every GlobalId the anchored builders emit (`addWallToStore`, `addSlabToStore`, `addColumnToStore`, `addBeamToStore`, `addDoorToStore`, `addWindowToStore`, `addSpaceToStore`, `addRoofToStore`, `addPlateToStore`, `addMemberToStore`, plus the shared emit helpers), `DuplicateInStoreOptions.guidRandom` does the same for `duplicateInStore`, and `generateSpacesFromWalls` / `generateSpaces` forward `options.guidRandom`. Same seeded source in, identical GlobalIds out - the in-store counterpart of `ProjectParams.GuidSource` from the previous release. Defaults unchanged (platform CSPRNG).
