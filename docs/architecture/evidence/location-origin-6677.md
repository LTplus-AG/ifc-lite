# Declared georeference origin and geometry placement (#6677)

Verified on 2026-10-02 with the public Allplan IFC4X3_ADD2
[attachment](https://github.com/user-attachments/files/32949575/ifc.txt).
SHA-256: `ed9263543567357324d52ecf737e46e4be96c2688dd9c65d003294dfbab4b57d`.
This is also the file used for the placement-panel evidence in #6572.

## Production reproduction and cause

Loaded the complete 1.12 MB attachment through production's file input:
13,466 entities and 146 elements with geometry. The Location panel displayed
`32.12441, -19.91787`, reproducing the issue exactly.

The bundled EPSG:2056 definition transforms the declared map conversion
`2619073.0368, 1263523.6017` to longitude `7.69186230636631`, latitude
`47.52217553207048`, agreeing with the independent buildingSMART result in
the issue. The projection definition and coordinate ordering are correct.

The old Location code instead called the geometry-centre transform. The
attachment's element placements include, for example:

```text
#90=IFCCARTESIANPOINT((-2619042.5367503,-1263543.60168925,0.));
```

The actual production loader reported IFC Z-up RTC offset
`(-2619072.9867503, -1263533.65168925, 0)`, zero viewer originShift, and
Y-up shifted bounds from `(-13.367027819156647, -6, -5.200000017881393)` to
`(30.44999998807907, 5.000000014901161, 10.449999988079071)`.
Recovering the geometry centre and applying MapConversion nearly cancels the
Swiss map offset. Its resulting geographic centre is the reported Atlantic
position, about 2,888 km from the declared origin.

## Component oracle and behavior

The Location pin, coordinate readout and external map links now use the
declared origin. A searched/picked origin writes its own projected coordinates
back to Eastings/Northings, without subtracting the geometry centre. The origin
marker stays visible at high zoom independently of the footprint.

The panel reports the large geometry/origin discrepancy. The footprint, world
placement and KMZ continue to use actual element placements: moving only the
pin does not certify or repair the source model's geometry georeferencing.

Reproduce the component oracle from the repository root:

```sh
curl -L --fail -o /tmp/issue-6677.ifc https://github.com/user-attachments/files/32949575/ifc.txt
LOCATION_GEOREF_IFC=/tmp/issue-6677.ifc TEST_SHARDS=1000003 TEST_SHARD=256844 pnpm test --filter=@ifc-lite/viewer --env-mode=loose
```

Observed: **9 tests passed, 0 failed, 0 skipped**. These parse the full file,
mount the real LocationMap component with the captured production coordinate
frame, assert the Pratteln readout and external link, and click a searched
position through Apply to check the saved Eastings/Northings. Additional cases
cover local geometry, explicit millimetre map units, the LV95 name alias,
metadata without geometry, origin edits with a millimetre project and no MapUnit,
and nearby origin edits preserving map-absolute geometry. The geometry-centre regression explicitly retains
the original Atlantic result, preventing a fabricated geometry repair.

Before extending the suite, restoring only the base LocationMap.tsx made
**4 of the initial 6 tests fail**, including both the reported location and Apply
behavior. Restoring the fix passed all six; the extended suite passes all nine.
Three additional lifecycle regressions (shard `62762`) prove model-switch
cancellation, clearing missing metadata, and recovery from an unresolved CRS.

The unused geometry-aware inverse branch was removed: map-pick now has one
origin-only inverse, paired with `reprojectPointToLatLon`. Terrain application
retains existing model-base grounding and is explained by the elevation label.

Related validation: 32 reprojection tests, 14 adversarial reprojection tests,
8 LocationMap KMZ export tests, 15 properties localization tests, and all 329
data-package tests (including published EPSG control points) passed. Root
`pnpm typecheck` passed, including the test-program coverage audit. The viewer
production build and its top-level-await chunk check passed. Touched-file
oxlint, the module-size gate and `git diff --check` passed.

Browser evidence is the production reproduction above. The collaborative
browser could not reach this worktree's local server; the after-fix evidence
is the real-model component oracle, rather than a claimed browser screenshot.
