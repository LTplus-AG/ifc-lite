# Plane zone-fixture source closure

Frozen fixture repair `b743687f664d7d2ac5a6263b3a7a6cd89f58593b` reviewed against actual SDK c9c5979f04cea8c38213004d4f04df0dcfb40d05. **The P2 zone-fixture finding from /tmp/ifclite-plane-8a-closure-review.md is closed in source.** No source edits, builds, tests or jobs; no SDK execution qualification.

Geometry scenarios now retain DEFAULT only in size/ratio fields. Their cached context zone is either explicit1.25e-4 or SmTol::SizeEstimateToZoneTol3d(SM_USE_DEFAULT), with a finite positive <1e-3 admission assertion. Source/sibling cached zones use finite ctx.zone or explicit2e-4. Pinned SmTol.h567–575 explicitly maps DEFAULT to SM_MODEL_SIZE_ESTIMATE; pinned SmMath.h defines that estimate as50, and the inclusive0.5..500 branch returns1e-5. Thus the default geometry case uses1e-5, not numeric sentinel9876543.21.

The intermediate real MergeBrep observer, exact raw metadata/DEFAULT size+ratio checks, source/sibling effective comparisons and original volume/Empty assertions remain. The separate sentinel_zone_copy_only witness uses an actual empty SDK BRep and checked topology copy, checking exact arbitrary raw zone bits without clipping, volume integration or positive geometry assertions. That is the correct separation between raw compatibility and meaningful modeling tolerance.

No further concrete defect was identified in this narrow fixture repair. Actual qualification remains parent-owned.

## Exact SHA256 pins

- Git object `native/smlib-adapter/tests/context_metadata_tests.cpp`: `bbe7f1a9d6b527032d4f41a37a83e6171c2781514d835896d1b9ff6b27808fac`
- Patch: `0f25034aac0cc6bab638bca14368bede7b5b5eeb907b1b2a0a2cfa3cfd7ee90c`
- Primary SDK SmTol.h: `f55dbcb74ed96be5b67f8616a8c19690b951e993281375252e2eec00a7997824`
- Primary SDK SmMath.h: `b5e2a7999d0a836d557c0b420601b48d782a395d1f94f4d9a12b64a91a9787c4`
