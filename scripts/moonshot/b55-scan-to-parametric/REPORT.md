<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# B5.5: scan-to-parametric, one real scanned apartment (M5 final)

Bet: take one real laser scan of a real dwelling, extract its structure, emit
parametric IFC through `@ifc-lite/create`, mesh it with the kernel, and score
its headline quantities against a manually modelled reference of the same
apartment at a 5% bar. This is the first result in the program measured
against something the program did not author.

Every number below emits from `scorecard.json` in this directory. Nothing in
this directory is source data: see [privacy](#8-privacy) for what was
deliberately not committed and how that is enforced.

## 1. Verdict

**Partial pass. 12 of 16 scored rows are inside the 5% bar; 4 are outside, and
all 4 are the same quantity failing for the same reason.**

| Scope | Quantity | Scan-derived | Reference | Deviation | 5% bar |
|---|---|---|---|---|---|
| model | floor area | 64.726 m2 | 64.567 m2 | **+0.25%** | pass |
| model | volume | 163.443 m3 | 155.918 m3 | **+4.83%** | pass |
| model | area-weighted clear height | 2.525 m | 2.430 m | **+3.93%** | pass |
| model | bounding wall surface | 180.015 m2 | 159.021 m2 | **+13.20%** | **fail** |
| scan_room_001 | floor area | 45.576 m2 | 45.781 m2 | **-0.45%** | pass |
| scan_room_001 | clear height | 2.539 m | 2.438 m | **+4.11%** | pass |
| scan_room_001 | volume | 115.702 m3 | 110.677 m3 | **+4.54%** | pass |
| scan_room_001 | bounding wall surface | 120.771 m2 | 101.985 m2 | **+18.42%** | **fail** |
| scan_room_002 | floor area | 14.496 m2 | 14.203 m2 | **+2.06%** | pass |
| scan_room_002 | clear height | 2.559 m | 2.438 m | **+4.93%** | pass |
| scan_room_002 | volume | 37.089 m3 | 34.631 m3 | **+7.10%** | **fail** |
| scan_room_002 | bounding wall surface | 39.310 m2 | 36.934 m2 | **+6.43%** | **fail** |
| scan_room_003 | floor area | 4.654 m2 | 4.583 m2 | **+1.55%** | pass |
| scan_room_003 | clear height | 2.289 m | 2.315 m | **-1.14%** | pass |
| scan_room_003 | volume | 10.652 m3 | 10.611 m3 | **+0.39%** | pass |
| scan_room_003 | bounding wall surface | 19.934 m2 | 20.102 m2 | **-0.84%** | pass |

The headline the exam asked for -- "headline quantities within 5% of a manually
modelled reference" -- is **met for floor area, clear height and volume at
model scale, and met for all four quantities in one of the three rooms**. It is
**not met for the bounding wall surface**, which is perimeter times height and
is the one quantity that punishes a ragged boundary. Section 5 names that
obstruction and sizes it.

Read the floor-area row first, because it is the least deniable number here:
a 3.94 GB point cloud went in and 64.726 m2 came out against a human's
64.567 m2, with no reference data touching any stage of the extraction.

## 2. What the scan actually contains

`ingest-scan.mjs` streams the E57 through the repository's existing
`E57StreamingSource` (`@ifc-lite/pointcloud`) rather than a new parser. Node's
`openAsBlob` supplies the lazy `Blob` that source expects, so the 3.94 GB file
is never resident and never copied.

| | |
|---|---|
| container | E57 (ASTM E2807-11), one `Data3D` scan, page size 1024 |
| points | **69,453,196**, all finite (**0** non-finite) |
| per-point record | cartesian XYZ single-float, surface normals, RGB |
| colour / intensity | colour yes, intensity no |
| also inside the file | 250 registered pinhole photographs (4032 by 3024) with poses |
| extent | **11.81 x 11.63 x 2.74 m** |
| density | **506,008** points per m2 of plan |
| ingest | **3.152 s**, **22.0 M points/s**, whole file, one pass (page-cache and machine-load dependent, and the only figure in this report that is; the first cold run of the same pass took roughly 5.5 s) |

So this is not a survey-grade tripod scan of an empty shell. It is a dense,
coloured, photo-registered capture of a **furnished, occupied dwelling**, whose
vertical extent (2.74 m) is barely more than one storey. That matters for what
follows: every occlusion in the result is furniture.

The two structural surfaces are unmistakable in the full-cloud z histogram:
the floor's single strongest 1 cm bin holds **5,812,039** points and the
ceiling's holds **2,730,281**, against a background of roughly 0.2 M per bin
through the open air of the rooms. Fitted by count-weighted mean over a
+-3 cm band:

- floor plane **1.3687 m** below the scan's local origin (**15,699,994** points in band)
- main ceiling plane **z = 1.1626 m** (**8,160,054** points in band)
- **clear height 2.5312 m**

## 3. How the structure was extracted

Deliberately not "RANSAC over everything". On a furnished apartment that
returns a hundred planes -- table tops, doors, cupboard sides -- and the work
then moves to classifying and assembling them, which is where scan-to-BIM
research actually lives and is not a one-session bet. The narrower observation
that carries this exam:

1. **Two horizontal planes.** Fit only the floor and the ceiling, from the
   z histogram above.
2. **Rooms are the connected components of ceiling visibility in plan.** A
   wall's own footprint is never scanned: a scanner standing inside the rooms
   sees both faces of a partition and nothing between them, so partitions
   appear as empty channels in a 25 mm plan raster. Doorways do not leak the
   segmentation, because a doorway has a lintel above it -- looking up from a
   doorway you see the lintel soffit, not the ceiling.
3. **Wall thickness is the width of that empty channel.**

### The one threshold that matters, and why it is not hand-set

Step 2 needs a height above the floor at which a cell counts as "under a
ceiling". Too low and every room merges through the door lintels; too high and
a room with a dropped ceiling vanishes. `chooseCeilingCut` sweeps the cut over
**23** values from the fitted clear height down to **1.40 m** and records the room
count and total room area at each. It then takes the **finest stable
segmentation**: the longest run of consecutive cuts that agree on the room
count and whose total area varies by under 2%, ranked by room count first.

That ranking is load-bearing and was corrected during the run. The first
version took the *longest* plateau, and a cut low enough to merge the whole
apartment through the lintels is trivially stable over a wide band -- the
one-room plateau is 9 samples wide against the three-room plateau's 5, so
"longest" reliably returns the degenerate answer. Merging is a strict loss of
structure, so room count ranks first and width only breaks ties. The full
sweep is in `scorecard.json` (`variants.*.ceilingCut.sweep`), and the widest
stable plateau at each room count is emitted beside it
(`variants.*.ceilingCut.plateausByRoomCount`), so the choice is auditable
rather than asserted.

Chosen: **cut 2.131 m**, midpoint of the plateau **2.031 m to 2.231 m**, which
holds **3** rooms.

### What came out

| room | polygon area | perimeter | height | vertices | filled voids | unfilled voids |
|---|---|---|---|---|---|---|
| scan_room_001 | 45.576 m2 | 47.573 m | 2.539 m | 76 | 920 (1.855 m2) | 1 (0.251 m2) |
| scan_room_002 | 14.496 m2 | 15.364 m | 2.559 m | 11 | 268 (0.319 m2) | 1 (1.278 m2) |
| scan_room_003 | 4.654 m2 | 8.710 m | 2.289 m | 7 | 4 (0.003 m2) | 0 |

`scan_room_003`'s height of 2.289 m is a genuinely dropped ceiling, found
without being told to look for one: its own ceiling mode sits about 0.25 m
below the other two rooms'.

Wall channels measured between components: **0.075 m**, **0.075 m** and
**0.400 m**.

## 4. The emitted model

`generate-ifc.mjs` builds through the shipped `@ifc-lite/create` API -- no
hand-written STEP -- and produces a **30,535**-byte IFC holding **3**
`IfcSpace` extruded solids, **29** `IfcWall`s and **1** `IfcSlab`. The
measurement side (`measure-ifc.mjs`) then meshes it with the production kernel
(`buildPrePassOnce` + `processGeometryBatch`) and reduces the triangles to
quantities. **The reference model goes through the identical call.** Neither
file's stored quantities are read -- the reference carries no
`IfcElementQuantity` at all, and scoring a stored number against a computed one
would be meaningless.

Two things in the emitted model are **not measurements** and are flagged as
such in `emitted.json` rather than scored: the slab thickness (**0.20 m**
nominal -- an interior scan never sees the slab soffit) and the exterior wall
thickness (emitted at the modal *interior* channel width, because a
single-sided interior scan carries no information about how thick an outside
wall is).

## 5. Where it misses, precisely

All four failures are one quantity, `lateralArea` -- the room's bounding wall
surface, which is perimeter times height -- plus the one volume row that
inherits from it. Two independent causes, and they are separable:

**(a) The extraction merged two reference spaces into one room.** The
reference has **4** `IfcSpace`s; the extraction found **3**. The missing one is
the reference's smallest at **2.420 m2**: its ceiling region is connected to
its neighbour's in the raster, so it never separates. The scorer handles this
honestly instead of dropping it -- correspondence is by plan-centroid
containment, so both reference spaces map to `scan_room_001` and that row is
scored against their aggregate and flagged `mergedReferenceSpaces: 2`. A merge
is roughly neutral for area (**-0.45%**) and badly non-neutral for perimeter,
because merging two rooms should *remove* the shared partition's two faces and
the ragged raster boundary does not.

**(b) Boundary raggedness in the poorly-covered region.** `scan_room_001`'s
outline is **47.573 m** against the merged reference's **41.825 m**: an excess
of **5.748 m**, **+13.74%**. The other two rooms show no such excess --
`scan_room_002` at **15.364 m** against **15.147 m** and `scan_room_003` at
**8.710 m** against **8.683 m**, both inside 1.5%. So the perimeter machinery
is sound and the excess is local: it is concentrated in the part of
`scan_room_001` where the ceiling was barely captured, which is the same
region that swallowed the merged space.

**It is not raster staircase.** That was the first hypothesis, and it is
wrong. The apartment sits at **51.087 degrees** to the E57 axes, so an
axis-aligned 25 mm raster should inflate perimeter by up to sqrt(2) on every
wall. A second full run (`--principal-frame`) rasterizes in the building's own
frame instead -- the angle taken from the minimum-area rectangle of the
scanned footprint, i.e. from the scan and nothing else -- and it cleans the
outlines up dramatically (`scan_room_002` from **11** vertices to **4**,
`scan_room_003` from **7** to **4**) while changing the verdict not at all:
**12** of **16** rows, model bounding wall surface **+13.09%** against
**+13.20%**. Both runs are in `scorecard.json`. That variant was added after
seeing the primary run's 76-vertex outline, which is a defect visible in the
scan without the reference; it is reported beside the pre-registered primary
run, not instead of it.

**Closing the gap** needs the segmentation to separate the fourth space and
the boundary to be regularised into wall lines rather than traced from cells:
fit 2D lines to the wall-channel points, snap room outlines to the fitted line
arrangement, and take the room polygon as a face of that arrangement. That is
the standard next step in the literature and is a day or two of work, not a
research programme. It would move `lateralArea` and leave the area rows where
they are.

## 6. The reference is wrong about height, and the scan can prove it

The clear-height rows pass, but at **+3.93%** model-wide they pass
uncomfortably, and the honest reading is not that the extraction is 4% off.

**3** of the reference's **4** spaces have a height of exactly **2.4384** m,
which is 8 feet -- an authoring-tool default. To test whether it was measured,
`score.mjs` counts scan points within +-1 cm of each reference space's
modelled top elevation and compares against the background level: the median
1 cm bin in the open air of the rooms, times three bins, **540,204** points.

| reference space | height | top elevation | scan points within +-1 cm | supported? |
|---|---|---|---|---|
| ref_space_A | 2.4384 m | 1.0724 m | 351,062 | **no** |
| ref_space_B | 2.4384 m | 1.0724 m | 351,062 | **no** |
| ref_space_C | 2.3150 m | 0.9490 m | 1,645,945 | yes |
| ref_space_D | 2.4384 m | 1.0724 m | 351,062 | **no** |

The scan's own fitted ceiling carries **6,586,376** points in the same window
-- **18.8x** more than the three defaulted tops, which themselves sit *below*
the empty-air background. Meanwhile `ref_space_C`, the one room whose modelled
height the modeller clearly did measure (its dropped ceiling), is the room
where this pipeline lands within **-1.14%** on height, **+1.55%** on area,
**+0.39%** on volume and **-0.84%** on wall surface: every quantity inside
1.6%.

So on the height quantity, **the scan-derived model is closer to the building
than the reference model is**, by **0.093 m**. That propagates: `scan_room_002`
misses volume by **+7.10%**, and volume decomposes exactly as area times
height -- **+2.06%** area against **+4.93%** height. Take the height error out
and that row passes.

This is reported as a finding, not used as an excuse: the scored table in
section 1 scores against the reference as it is, defaults and all. But a bet
whose stated purpose is contact with the outside world should say plainly when
the outside world's artifact is the one that drifted.

## 7. What was NOT done, and every shortcut taken

- **The second half of the B5.5 exam clause was not attempted.** The bet as
  written is "one real scanned room to parametric IFC ... **plus one
  world-model scene imported with a bill of quantities**". Only the first
  clause was run. The second is a separate ingest path against a different
  kind of input and shares no machinery with what is here; it is not blocked
  by anything above, it was simply out of budget.
- **No openings.** No windows or doors were detected or emitted. The reference
  has **3** windows, **3** doors and **6** opening elements. Opening detection
  from an interior scan is tractable (wall-plane point voids) and was cut for
  time, not for difficulty.
- **No wall-thickness validation.** Channel widths came out at **0.075 m**,
  **0.075 m** and **0.400 m** in the primary run and **0.05 m**, **0.05 m**,
  **0.325 m** in the principal-frame run. The reference's wall types span
  90 mm to 350 mm, so the measurement is the right order and the thin channels
  are biased low -- the topmost points on a wall's visible face fall at ceiling
  height and are themselves counted as ceiling cells, eating roughly one cell
  per side. That bias is stated, not corrected: correcting it after seeing the
  reference's thickness set would be exactly the kind of move this bet is
  supposed to refuse. The third channel is between two rooms that are not
  directly adjacent everywhere and should be treated as unvalidated.
- **Areas are ceiling-derived, not floor-derived.** Room area here is the
  plan area of ceiling visibility. For a room with vertical walls that equals
  the floor area, which is the assumption; a sloped or stepped ceiling would
  break it and this scan has neither.
- **Single storey.** The scan is 2.74 m tall. Nothing here handles more than
  one storey.
- **Subsampled.** The geometric passes run on every 10th point
  (**6,945,320** of **69,453,196**). The plane fits and histograms use all
  **69,453,196**.
- **No registration was needed or performed.** The scan and the reference
  share a coordinate frame -- verified, not assumed: the two models' space
  bounding boxes agree to a maximum corner offset of **0.118 m** with no
  transform applied to either side (`frameCheck` in `scorecard.json`). That is
  a gift from this particular data pairing (the reference was modelled on this
  scan) and would not hold for an arbitrary scan/model pair. **A bet run on
  unregistered inputs would have to solve registration first, and that is a
  real piece of work this exam did not have to do.**
- **`scan_room_002` carries a 1.278 m2 unscanned void** inside its outline.
  The emitted `IfcSpace` profile is a single outer loop, so the void is
  included in the emitted area by construction of the output format.
- **Ordering disclosure.** The reference's per-space quantities were computed
  before the extraction pipeline was finalised -- unavoidable, since the
  reference had to be parsed to know what was comparable at all. The mitigation
  is structural rather than procedural: `ingest-scan.mjs`, `extract-rooms.mjs`
  and `generate-ifc.mjs` do not read the reference, no threshold in them was
  chosen by watching a deviation, and the two changes made after the first
  scored run (the plateau ranking in section 3, the principal-frame variant in
  section 5) were both driven by defects visible in the scan alone. The
  principal-frame variant made the score marginally *worse*, which is what an
  honest non-tuning change looks like.

## 8. Privacy

The scan and the reference are client data, and both carry a real site
location: the reference has `IfcSite` latitude and longitude, the E57 carries a
projected-CRS definition. Neither source file, nor the generated IFC, nor any
room polygon, nor any string from either file is committed. `scorecard.json`
holds derived scalars only, in the scan's own local metres, with neutral labels
(`ref_space_A`, `scan_room_001`).

That is enforced, not promised. `run.mjs::assertNoIdentifiers` fails the run if
the committed artifact contains a string value outside a fixed allowlist, a key
outside an identifier pattern, any quoted string of 10 or more characters
lifted from the reference file, or anything shaped like a
degrees/minutes/seconds tuple. It fired twice during development and both leaks
were removed.

## 9. Reproduction

```bash
node scripts/moonshot/b55-scan-to-parametric/run.mjs \
  --scan /path/to/Apartment.e57 \
  --reference /path/to/reference.ifc \
  --work "$SCRATCH/b55-work"
```

Requires a built tree (`pnpm build`) with staged wasm. Peak on-disk cost
outside the repository is the subsample at **83,343,840** bytes; the source
file is read in place and never copied. Ingest is **3.15 s** and
everything after it is **1.29 s**.

## 10. One side effect on the numerals gate, flagged not fixed

`check-report-numerals.mjs --gate` passes on this directory: every numeral in
this report is either backed by `scorecard.json` or carries a marked reason,
and none is unbacked. It does **not** pass on the whole tree with this
directory present, and the reason is worth a maintainer's attention rather than
a quiet edit.

The `docs/vision` prose set is checked against the UNION of every moonshot
artifact in the tree. Adding this bet's several hundred numbers to that union
coincidentally puts a value within half-ULP of two tokens that other documents
had legitimately marked as unbacked, so those markers now read as STALE: this
scorecard's nominal slab thickness lands on a `0.20x` speedup endpoint in
`moonshots-tech.md` and in the G4 review, and one ceiling-sweep total area
lands on a count in the G2 review that belongs to a bet on another branch.
Neither marker's reason stopped being true; an unrelated file merely grew a
number of the right size.

Deleting those markers would be wrong -- the excuses are still correct -- and
`docs/vision` is outside this bet's writable domain, so nothing was changed
there. The structural fix is for the union-index check to bind a marker to the
artifact set its own bet emits, or to require the backing value to come from
the document's own bet. Left for the maintainer.

<!-- numeral-ok: 350, 250, 4032, 3024, 1024 ::
     domain and format constants that no artifact stores, plus two bounds.
     350 is the top of the reference's wall-type range in mm, read from its
     IfcMaterialLayerSet and
     deliberately NOT emitted to the scorecard because it is reference detail
     this bet has no business republishing. 250 / 4032 / 3024 / 1024 are the
     E57's own embedded-photo count, pixel dimensions and page size, read from
     its XML section, which this pipeline characterises but does not decode. -->
