<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# LandXML → IFC mapping specification (v1, proposed)

Status: **accepted — v1 implemented; v1.1 (horizontal alignments, §11) implemented; v1.2 (vertical
profiles, §12) implemented; v1.3 (station equations, §14) implemented; v1.4 (terrain imagery,
§15) specified — its projection (§15.3) is implemented, the viewer drape (§15.4) and the export
(§15.5) are not yet**.
Version 1.4, 2026-09-25.
(Version 0.1, 2026-09-22, was the proposal; §9 records what changed on acceptance.)
Issues: [#5175](https://github.com/LTplus-AG/ifc-lite/issues/5175) (export honesty),
[#4937](https://github.com/LTplus-AG/ifc-lite/issues/4937) (native LandXML).

This document exists because #5175 requires that an opt-in LandXML→IFC mapping be
*defined and reviewed before it is built*, rather than an implicit `Ifc*` projection
invented to satisfy an export button.

It has now been reviewed and accepted with the four resolutions in §9. Implementation
follows this document; anything not written here is not in v1, and a change to the
mapping is a change to this document first.

v1 is implemented: `landXmlToIfc` in `@ifc-lite/create` performs the conversion, and
`apps/viewer/src/lib/export/landXmlIfcPlan.ts` answers §6's coverage question for the
export dialog. The blanket refusal it replaced is pinned, in its remaining form, by
`ExportDialog.landxml.test.tsx` — a LandXML model whose document was not retained still
refuses, as does a source with no covered record.

## 1. What this mapping is, and is not

It **is** a one-way, opt-in, clearly-labelled derivation of a bounded subset of LandXML
source records into IFC4X3 entities, for the workflow "I loaded terrain/survey data and
I need it in an IFC-consuming tool".

It is **not**:

- a round-trip format (IFC→LandXML is out of scope and not planned);
- a claim that the IFC output is equivalent to the LandXML source;
- a replacement for the source records, which remain the authoritative model in the
  viewer and continue to be exportable in their original format;
- certification of any producer's export.

Every file produced by this mapping is stamped as a derived conversion (§7).

## 2. Prerequisites

§2.1 is blocking: the mapping is incorrect without it. §2.2 is not blocking, but it is a silent
failure mode the implementation must defend against.

### 2.1 Units (issue #5175 step A.1)

A numeric, renderable surface must have declared `LandXML/Units`. This is enforced
identically on the streaming and non-streaming parse paths (LXML009). A model that
refuses to load cannot be exported, so the mapping inherits the units contract for
free — **except** where the reviewed `assumedLinearUnit` override (step A.2) was used,
in which case the assumption is carried into the export as provenance (§7) and must
never be presented as a declared unit.

### 2.2 Coordinate order — ifc-lite is correct; defend against transposed input

LandXML's `<P>` and `<CgPoint>` element text is **northing easting elevation**, not X Y Z.
`rust/landxml` implements this correctly:

- `rust/landxml/src/parser/capture.rs` binds `northing: values[0]`;
- `rust/landxml/src/plan/model.rs` documents the field order as
  *"LandXML's authored northing/easting/elevation order"*;
- `rust/landxml/src/terrain.rs` builds planar vertices as `[easting, northing]`,
  i.e. X = easting, Y = northing.

The reviewed vendor fixtures (InfraModel/3D-Win, Civil 3D, OpenRoads, Aplitop, Novapoint) are
consistent with this reading. No evidence of a producer disagreeing has been established.

One local, non-vendor file did disagree and is worth recording so the next reader does not
re-derive it: `bonsai-topo/data/output/client_survey.xml`, produced by
`bonsai-topo/src/core/converters/ifc_to_landxml.py`, which writes

```python
pnt.text      = f"{vertex[0]:.3f} {vertex[1]:.3f} {vertex[2]:.3f}"     # x y z
cg_point.text = f"{point['x']:.3f} {point['y']:.3f} {point['z']:.3f}"  # x y z
```

— easting first. That converter is one-way and has no LandXML reader, so the defect never
surfaced in its own pipeline. It is a bug in that converter, **not** a reason to change the
ifc-lite read. Its output is therefore not usable as a georeferencing control until the
converter emits `y x z`.

This does not block the mapping. What it does justify is a cheap defensive check, because the
failure mode is silent: a transposed source still produces a well-formed mesh (a transpose is a
reflection), so it renders — in the wrong place — and every count-based assertion passes.

Decided for v1 (§9.1) — in the exporter's pre-flight and in the loader:

1. When a CRS is declared, test the coordinates against that CRS's valid easting/northing ranges
   and **warn prominently** — never refuse, never auto-correct — when the values can only be the
   other way round. For EPSG:3006 a 6.4-million value can only be a northing. §9.1 is why this
   warns rather than refuses.
2. Offer an explicit, user-confirmed "swap northing/easting" toggle, recorded as provenance
   exactly like the units override, for operators who must consume a known-faulty source.
3. **Rejected:** producer-sniffing on `Project/Application/@name` — unmaintainable, and it
   encodes one tool's bug as a rule.

Never infer the order from coordinate magnitude without a declared CRS to bound the test.

## 3. Target schema

IFC4X3, written with IFC4X3_ADD2's entity layouts. `IfcCreator` is configured with the
`IFC4X3` schema tag, which selects those layouts. Since v1.1 the converted file *declares*
`FILE_SCHEMA(('IFC4X3_ADD2'))`, as all IFC4X3 output from `IfcCreator` now does (§11). The
bare `IFC4X3` token is resolved by IfcOpenShell, and by the buildingSMART validator built
on it, to a later development schema whose layouts differ, so the same bytes declared as
`IFC4X3` fail validation (#5351). All entity and attribute definitions below were taken
from `packages/codegen/schemas/IFC4X3.exp`.

## 4. The v1 mapping

| LandXML source record | IFC4X3 | Notes |
|---|---|---|
| `Surfaces/Surface` with `Definition surfType="TIN"` | `IfcGeographicElement` with `PredefinedType = .TERRAIN.`, body representation `IfcTriangulatedIrregularNetwork` | `IfcGeographicElementTypeEnum` contains `TERRAIN`. See §4.1 for the TIN constraints. |
| `CgPoints/CgPoint` | `IfcAnnotation` with `PredefinedType = .SURVEY.` + one `IfcPropertySet` per point | `IfcAnnotationTypeEnum` contains `SURVEY`. Deliberately the same shape IfcOpenShell emits, so output is directly comparable to a known control (§8). |
| `CoordinateSystem` | `IfcProjectedCRS` + `IfcMapConversion` | Only when a CRS is actually declared. §4.2. |
| `Units/Metric\|Imperial` | `IfcUnitAssignment` with `IfcSIUnit`, or a conversion-based unit for foot / US survey foot | The parser already resolves the scale table; reuse it, do not re-derive. |
| `Project`, `Application` | `IfcProject`, `IfcApplication`, `IfcOwnerHistory` | §7 provenance. |
| — | `IfcSite` | One site, containing everything. |

### 4.1 TIN geometry

`IfcTriangulatedIrregularNetwork` is `SUBTYPE OF (IfcTriangulatedFaceSet)` and carries
two constraints that an author must satisfy deliberately:

```
ENTITY IfcTriangulatedIrregularNetwork
 SUBTYPE OF (IfcTriangulatedFaceSet);
	Flags : LIST [1:?] OF IfcInteger;
 WHERE
	NotClosed : SELF\IfcTriangulatedFaceSet.Closed = FALSE;
END_ENTITY;
```

- `Flags` is **mandatory** and must be non-empty. It is not optional the way most
  IFC list attributes are.
- `Closed` must be written explicitly as `.F.`, not omitted — `NotClosed` tests for
  `= FALSE`, and `$` does not satisfy it.
- Inherited from `IfcTessellatedFaceSet`: `Coordinates : IfcCartesianPointList3D`
  (`CoordList : LIST [1:?] OF LIST [3:3] OF IfcLengthMeasure`).
- Inherited from `IfcTriangulatedFaceSet`: `CoordIndex : LIST [1:?] OF LIST [3:3] OF
  IfcPositiveInteger` — **1-based**, and `Normals`/`PnIndex` optional.

Vertex order: `CoordList` entries are `(X, Y, Z)` = `(easting, northing, elevation)`,
consistent with `terrain.rs`, and subject to §2.2.

Only surfaces whose `render_state` is `Rendered` are exported. A preserved-only or
faceless-refused surface is **not** silently dropped — it is named in the refusal
report (§6).

### 4.2 Georeferencing

```
IfcProjectedCRS: Name (required in practice — WHERE NameOrWKT), VerticalDatum,
                 MapProjection, MapZone, MapUnit (must be a length unit)
IfcMapConversion: SourceCRS, TargetCRS, Eastings, Northings, OrthogonalHeight,
                  XAxisAbscissa?, XAxisOrdinate?, Scale?
```

`LandXmlCoordinateSystem` currently keeps `horizontal_datum` / `vertical_datum` as raw
strings, and the crate deliberately does not resolve EPSG codes — only the viewer
adapter accepts explicit EPSG ids. The exporter must not start resolving EPSG codes in
the crate. Where the source declares no CRS, emit **no** `IfcProjectedCRS`/
`IfcMapConversion` at all rather than a placeholder, and say so in the report. Two of
the seven reviewed producer fixtures declare `crs: "not-declared"`, so this is the
common case, not an edge case.

### 4.3 GlobalId derivation

GlobalIds are derived deterministically from the LandXML source id
(`landxml:surface:3`, `landxml:surface:3:point:41`, …) so that re-exporting an
unchanged source produces an unchanged file and `ifc-lite diff` is meaningful. The
derivation is `uuidToIfcGuid(uuidFromSeed(sourceId))` — see §10. Do not mint random
GUIDs. The source id is already
stable and already the crate's semantic identity — this is the property that makes it
usable here.

## 5. Explicitly refused in v1

Named in the refusal, never silently dropped:

- `Alignments` (horizontal geometry, stationing, cant, superelevation)
- `Profiles`, `ProfAlign`, roadways, `CrossSects`
- `Parcels`, `Monuments`, plan features
- `PipeNetworks`, `Structs`, `Pipes`
- `Surface` `SourceData` breaklines, boundaries, contours
- any surface that is not `Rendered`

`IfcAlignment` exists in IFC4X3 and a mapping is feasible, but it is a substantial
independent piece of work with its own correctness surface (segment geometry, spirals,
station equations) and its own review. It is not v1.

## 6. Export behaviour and UI

- `canExportIfc` stops being a blanket `false` for LandXML and becomes "the loaded
  records are covered by this mapping".
- A model containing *any* out-of-scope record still exports, but the dialog states, by
  record family, what will not be included, before the user commits. No silent partial.
- A model containing *no* in-scope record continues to refuse outright.
- The source-format export route (#5175 step A.5) remains available in every case and
  stays the recommended path — the error string
  `exportDialog.landXml.error` already tells users to export the original file.

## 7. Provenance

Every produced file records, in the IFC header and in a property set on `IfcProject`:

- that it is a derived conversion, the source filename and its hash;
- this mapping document's version;
- whether an `assumedLinearUnit` override was in force (§2.1), and its value;
- whether a coordinate-order override was in force (§2.2);
- the record families that were refused (§5).

## 8. Acceptance evidence

A count check is not acceptance — §2.2 shows why a transposed export passes every
count-based assertion.

1. **Round-trip**: re-load the exported IFC through ifc-lite and assert vertex count,
   triangle count, point count, and per-vertex coordinates against the LandXML source
   within a stated tolerance — *including* which coordinate landed in X and which in Y.
2. **Independent control**: the survey-point path is structurally compared against
   `bonsai-topo/data/output/client_survey.ifc` — same entity shape, same CRS entities.
   Note that this control is itself subject to §2.2; a disagreement there is evidence
   about the control, not automatically a defect in our output. Resolve §2.2 first.
3. **Refusal tests**: one per out-of-scope record family in §5, asserting the family is
   named in the report.
4. **Determinism**: exporting the same source twice is byte-identical apart from the
   timestamp.
5. **Schema validity**: the `IfcTriangulatedIrregularNetwork` `Flags`/`Closed`
   constraints in §4.1 are asserted directly, not assumed.

Fixture rows added for this work follow the manifest-v2 provenance requirements, and
synthetic fixtures are marked synthetic. Per the coverage ledger's rule, a synthetic
fixture proves an invariant and never certifies a vendor export.

## 9. Review resolutions

The four questions the v0.1 proposal left open, and how they were decided on 2026-09-23.
Recorded rather than deleted: the reasoning is the part that a later change has to argue
against.

### 9.1 CRS-range plausibility check — **in v1, as a loud warning, never a refusal**

Question: is the §2.2 check in scope for v1, or a separate hardening issue?

Decided: in v1. It warns prominently; it does not refuse and it does not auto-correct.

A transposed source is silent by construction (§2.2) — it renders, and every count-based
assertion passes — so deferring the check means shipping a path whose worst failure is
invisible. Warning rather than refusing is the deliberate half: the check is a
plausibility test against a declared CRS's bounds, not a proof, and a refusal built on a
heuristic would block legitimate edge-of-zone data. The user is told, loudly, and decides.

Consequences for the implementation:

- The check runs only where a CRS is declared and its easting/northing bounds are known.
  With no declared CRS there is no test and no warning — magnitude alone never triggers it
  (§2.2 closing line).
- The warning names the coordinate that is implausible and the bound it violates, e.g.
  *"northing 6 407 123 is outside EPSG:3006's easting range — the source may be written
  easting-first"*. A warning a user cannot act on is noise.
- It appears in the export report **and** in the pre-flight the dialog shows before the
  user commits (§6), not only in the produced file.
- The user-confirmed swap toggle (§2.2 item 2) remains v1 scope and is recorded as
  provenance (§7) exactly like the units override.

### 9.2 Terrain carrier — **`IfcGeographicElement` / `.TERRAIN.`**

Question: `IfcGeographicElement`/`.TERRAIN.`, or hang terrain off `IfcSite` directly?

Decided: `IfcGeographicElement` with `PredefinedType = .TERRAIN.`, one per surface,
contained in a single `IfcSite`.

The deciding argument is the one the question itself names: a LandXML file routinely
carries several named surfaces (existing ground, design, a subgrade), and `IfcSite` can
carry only one representation. Collapsing them onto the site would either drop surfaces
or merge distinct records into one mesh, and §5's rule is that nothing is silently
dropped. The objection — that this introduces an element with no real-world counterpart —
is real but weaker: `.TERRAIN.` is precisely what `IfcGeographicElementTypeEnum` provides
for, and the surface's LandXML name survives as the element's `Name`, which is what makes
the output navigable in a consuming tool.

### 9.3 `CgPoint` carrier — **`IfcAnnotation` / `.SURVEY.`**

Question: `IfcAnnotation`/`.SURVEY.` (matches the observed control) or `IfcReferent`?

Decided: `IfcAnnotation` with `PredefinedType = .SURVEY.`, plus one `IfcPropertySet` per
point.

`IfcReferent` is arguably the more correct IFC4X3 answer for survey control, and this is
the resolution most likely to be revisited. It is not v1 for a concrete reason:
`IfcReferent` is defined in terms of positions **along an alignment**, and v1 has no
alignments (§9.4). Emitting referents with nothing to refer to would be a worse claim than
emitting annotations. `IfcAnnotation`/`.SURVEY.` is also what the one available control
uses (§8.2), which makes the output directly comparable to something outside this repo —
the only independent check the survey path has.

Revisit when alignments land: if v2 maps `Alignments`, `IfcReferent` becomes available in
its intended sense and this decision should be re-argued rather than inherited.

### 9.4 Shipping without alignments — **yes, ship v1; refuse alignments by name**

Question: is a mapping that cannot represent alignments worth shipping, given that two of
the reviewed producer fixtures are alignment-only and would export nothing?

Decided: yes. Alignments are refused **by name** (§5), and an alignment-only file refuses
outright rather than producing an empty IFC.

That last clause is the whole answer to the objection. The failure mode the question
worries about is a user exporting an alignment-only file and receiving a valid, empty,
useless IFC — so v1 does not do that. A file with no in-scope record refuses with a
message naming what it contains and why that is not covered, which is strictly more useful
than an empty file and honest in the same way §6 requires of partial coverage.

For the terrain and survey files that v1 *does* cover — the majority of the reviewed
fixtures — withholding the mapping until `IfcAlignment` is done would delay a correct,
bounded capability behind a substantially larger independent piece of work. Alignments
remain a follow-up with their own review (§5).

## 10. Implementation notes

Recorded during implementation; they constrain the code but do not change the mapping.

- **Deterministic GUIDs (§4.3).** `uuidFromSeed` (`@ifc-lite/encoding`) composed with
  `uuidToIfcGuid` is the derivation. §4.3's "existing deterministic GUID helper" did not
  resolve to a single function when it was written: `uuidFromSeed` produces an
  RFC-4122-shaped UUID from a seed string, and `uuidToIfcGuid` compresses it to the
  22-character `IfcGloballyUniqueId`. The seed is the source id verbatim
  (`landxml:surface:3`), so the identity scheme is the crate's, not a second one.
  **Known limitation:** source ids are document-local, so two *different* files
  with the same surface ordinal produce the same element GlobalId. The file-level
  entities (project, site, relationships) are seeded from `sourceHash` when the
  caller supplies it, which keeps two such exports from colliding at the site
  when federated; callers should always pass it.
- **Where the converter lives.** `packages/create/src/landxml/`, reached through
  `@ifc-lite/create`. It declares its own minimal structural input type rather than
  importing the viewer's `LandXmlTinDocument`, so the converter is testable without the
  viewer and the viewer's document type structurally satisfies it. A package that needs
  the viewer to be unit-tested is not a package.
- **Target schema tag.** `IfcCreator` is configured with `IFC4X3`, and since v1.1 the file declares `IFC4X3_ADD2` (§3, §11).

## 11. v1.1 — horizontal alignments

§5 refused alignments with a note that `IfcAlignment` "is a substantial independent piece
of work with its own correctness surface". v1.1 is that work, bounded to what can be
written correctly and *proven* correct against an engine this repo does not control.

### 11.1 What is written

| LandXML | IFC4X3 |
|---|---|
| `Alignment` | `IfcAlignment`, **aggregated by `IfcProject`** (`IfcRelAggregates`), not contained in the site |
| its horizontal geometry | `IfcAlignmentHorizontal`, nested under the alignment (`IfcRelNests`) |
| each `CoordGeom` element | `IfcAlignmentSegment` → `IfcAlignmentHorizontalSegment`, nested in order under the horizontal layout |
| — | a **zero-length terminating** `LINE` segment at the end, as IFC 4.3 requires |
| `staStart` | an `IfcReferent` / `.STATION.` at distance 0, with `Pset_Stationing.Station` |
| the geometry | `IfcCompositeCurve` of `IfcCurveSegment` as the alignment's `'Axis'` / `'Curve2D'` representation |

The structure — which relationship owns what, the terminating segment, the station
referent's `IfcLinearPlacement` — mirrors what IfcOpenShell 0.8.5's `alignment` API
produces for the same input, which is maintained alongside the IFC 4.3 alignment work.

### 11.2 Segment types

| LandXML | `PredefinedType` | Geometry (`IfcCurveSegment.ParentCurve`) |
|---|---|---|
| `Line` | `LINE` | `IfcLine` |
| `Curve` | `CIRCULARARC` | `IfcCircle` |
| `Spiral spiType="clothoid"` | `CLOTHOID` | `IfcClothoid` |

Everything else is refused **for the whole alignment**, by name: `IrregularLine`, any
`Spiral` whose `spiType` is not `clothoid`, and any location given only as an unresolved
point reference. An alignment is refused whole rather than written with a gap, because an
alignment with a missing segment is not a shorter alignment — it is a wrong one, and every
station after the gap would be wrong with it.

### 11.3 Conventions — where a sign error hides

- **Axes.** `StartPoint` is `(easting, northing)`, exactly as §2.2; direction angles are
  measured in that plane, counter-clockwise from +X (east), in radians.
- **Radius sign.** `StartRadiusOfCurvature` / `EndRadiusOfCurvature` are **positive for a
  counter-clockwise (left) turn and negative for clockwise**. `0` means infinite (a
  straight end of a spiral), matching LandXML's `INF`.
- **Geometry mapping.** Each `IfcCurveSegment` follows IfcOpenShell's
  `_map_alignment_horizontal_segment` exactly: placement at `StartPoint` along
  `StartDirection`; circle `SegmentLength` signed by the turn; clothoid constant
  `A = L / sqrt(|f|) · sign(f)` with `f = L/R_end − L/R_start`, and its `SegmentStart`
  offset for a spiral that does not start at infinite radius.
- **Transition codes** follow position / tangent / curvature continuity with the next
  segment; the terminating segment is `DISCONTINUOUS`, as `IfcCompositeCurve`'s
  `CurveContinuous` rule requires of exactly one segment.

### 11.4 Self-check before writing

Each segment's parameters are integrated to its end point and compared with the
**authored** end point, and each authored end with the next segment's authored start. A
mismatch beyond tolerance refuses the alignment, naming the segment and the distance.
This is the check that catches a sign error in a spiral or a line: one turning the wrong way
lands somewhere else, and the comparison says where.

Each segment's **evaluated** end is also compared with the next segment's start, because
that is the join the written curve has. Both points are within tolerance of the authored
one, so they can still be up to twice the tolerance apart. The writer labels a join within
the tolerance continuous, so it may never see a larger gap: `IfcCompositeCurve.CurveContinuous`
allows an open curve exactly one `.DISCONTINUOUS.` segment, the last. The writer uses this
tolerance for the transition code instead of IfcOpenShell's 1 mm, because authored joins
reproduce only to a few millimetres, and it throws on a larger mid-curve gap rather than
writing one.

It **cannot** catch a flipped `rot` on a circular arc. Start, centre and end describe one
circle, and the other rotation is simply the other arc of it (270° instead of 90°), which
ends at the same point. The authored arc `length` is what distinguishes them, so when a
curve declares one it must agree with the computed length, or the alignment is refused.
Without a declared length the authored `rot` is taken at its word; the test suite records
that limit rather than hiding it.

The converted file declares `FILE_SCHEMA(('IFC4X3_ADD2'))`, not the bare `IFC4X3` (§3,
#5351). The layouts written are unchanged; only the declared identifier changed.

### 11.5 Still refused

Cant, superelevation, cross sections and roadways. Each is named with its count, as in §5.
Vertical profiles are mapped since v1.2 (§12) and station equations since v1.3 (§14), which
also re-argues `IfcReferent` for `CgPoint` (§9.3, §14.3).

### 11.6 Acceptance

1. **Independent geometry parity.** IfcOpenShell regenerates each `IfcCurveSegment` from our
   `IfcAlignmentHorizontalSegment` through its own mapping, and the result must equal ours.
2. **Independent evaluation.** IfcOpenShell evaluates our composite curve; every segment
   boundary must land on the LandXML-authored point.
3. **Schema conformance.** `ifcopenshell.validate(express_rules=True)`, as §3 requires.
4. **Refusals.** One test per refusal reason in §11.2 and §11.4.

## 12. v1.2 — vertical profiles

§11.5 refused vertical profiles. v1.2 maps a written alignment's **design** profile
(`Profile/ProfAlign`) to `IfcAlignmentVertical`, bounded, as in §11, to what can be written
correctly and proven correct against IfcOpenShell.

### 12.1 What is written

| LandXML | IFC4X3 |
|---|---|
| the alignment's `ProfAlign` | `IfcAlignmentVertical`, nested under the `IfcAlignment` in the same `IfcRelNests` as the horizontal layout (horizontal first); `Name` = the profile's name, `GlobalId` from the profile's source id (§4.3) |
| each grade and vertical curve | `IfcAlignmentSegment` → `IfcAlignmentVerticalSegment`, nested in order under the vertical layout |
| — | a **zero-length terminating** `CONSTANTGRADIENT` segment at the profile's end, carrying its end height and gradient |
| the geometry | an `IfcGradientCurve` of `IfcCurveSegment`s whose `BaseCurve` is the horizontal `IfcCompositeCurve` |

With a vertical layout the alignment carries two representations, exactly as IfcOpenShell
0.8.5's `_create_geometric_representation` writes the horizontal + vertical case: the
composite curve as `'FootPrint'` / `'Curve2D'` (first), and the gradient curve as
`'Axis'` / `'Curve3D'`. An alignment without a profile keeps §11's single
`'Axis'` / `'Curve2D'`. The station referent stays on the composite curve, which is the
curve IfcOpenShell's `get_basis_curve` returns for the same structure.

### 12.2 Which profile

- A profile belongs to the alignment named by its `parentAlignmentSourceId`. When that
  alignment also lists `profileSourceIds`, the list must name it; a profile the two
  disagree about, or whose alignment is not in the file, is refused as **unlinked**.
- A profile whose alignment is refused (§11.2, §11.4) is refused with it: it has no
  horizontal to measure distance along.
- IFC nests one vertical layout directly under an alignment. An alignment with **more than
  one** design profile has all of them refused by name, because choosing one would be a
  guess (IfcOpenShell's answer, child alignments per profile, is a separate structure and
  not v1.2).
- A sampled profile (`ProfSurf`, a ground line along the alignment) is a survey, not a
  design layout, and is refused.
- On an alignment with station equations, a profile's stations are read through them
  (§14.5). A profile is refused when a PVI station falls in an equation's gap or is displayed
  at more than one place along the alignment, or when the alignment's equations are
  themselves refused (§14.2).

### 12.3 Segment types

| LandXML | `PredefinedType` | Geometry (`IfcCurveSegment.ParentCurve`) |
|---|---|---|
| grade between curves, and each grade break at a bare `PVI` | `CONSTANTGRADIENT` | `IfcLine` |
| `ParaCurve` | `PARABOLICARC` | `IfcPolynomialCurve` |
| `UnsymParaCurve` | **two** `PARABOLICARC`, split at the PVI station | `IfcPolynomialCurve` (each) |
| `CircCurve` | `CIRCULARARC` | `IfcCircle` |

IFC has no asymmetric parabola. An `UnsymParaCurve` with legs `Lin`, `Lout` and grade change
`Δ = g2 − g1` is two parabolas meeting at the PVI station with a common height and gradient
`gm = g1 + Δ·Lout / (Lin + Lout)`: the curve both legs of the LandXML definition describe
(the same reading as `rust/landxml`'s profile evaluator). Written as two segments it is
exact, not an approximation.

Each `IfcCurveSegment` follows IfcOpenShell's `_map_alignment_vertical_segment` exactly:
placement at `(StartDistAlong, StartHeight)` along the start gradient; a line of length
`HorizontalLength / cos(atan(g))`; a polynomial with `CoefficientsY = (StartHeight,
StartGradient, (EndGradient − StartGradient) / (2·HorizontalLength))` and its closed-form
arc length; a circle whose radius and `SegmentStart` / `SegmentLength` angles derive from
the two gradients and the horizontal length. Transition codes compare position, gradient
and curvature in the distance/height plane; the terminator is `DISCONTINUOUS`.

### 12.4 Conventions

- **Distance along** is `(station − staStart) × linearScaleToMeters` on an alignment without
  station equations, and the station's one place along the alignment otherwise (§14.5); heights are
  `elevation × elevationScaleToMeters`. Gradients are computed from the converted values, so
  a file whose elevation unit differs from its linear unit still gets dimensionless ratios.
- **Lengths.** A `ParaCurve` / `UnsymParaCurve` length is horizontal. A `CircCurve` is fixed
  by its PVI, its radius and the two grades; its `length` only confirms them. Producers differ
  on which length they write: 3D-Win writes the **arc** length `R·|θ2 − θ1|` (θ = atan of each
  grade; its M3 road profile agrees to the millimetre on all nine curves, and one of them
  differs from the horizontal length by 1 cm), while `rust/landxml`'s evaluator reads the
  **horizontal** length `R·|sin θ2 − sin θ1|`. A declared length that equals either within
  §11.4's tolerance is accepted; one that equals neither is refused, naming both values.
- **`RadiusOfCurvature` sign.** Positive for a sag (the curve turns counter-clockwise in
  the distance/height plane, IFC's "positive values imply a CCW direction"), negative for a
  crest: `HorizontalLength / (EndGradient − StartGradient)` for a parabola, which is the
  `1/k` IfcOpenShell's `layout_vertical_alignment_by_pi_method` writes, and `±R` for a
  circle. A `CircCurve` in a file whose elevation unit differs from its linear unit is
  refused: its radius has no single unit. LandXML defines no sign for a `CircCurve` radius, but some
  producers (3D-Win) sign it with the same convention, negative for a crest; the magnitude is
  used, and a negative radius on a sag is refused as contradictory.
- A `ParaCurve` between two equal grades (equal to within 1e-9, since grades computed from PVIs on
  one straight line differ by rounding) is a straight grade; the grade is written and no
  curve segment is, since there is no curvature to carry.

### 12.5 Self-check before writing

The profile is refused whole, naming the PVI or curve and the reason, when:

- it has fewer than two PVIs, a PVI without an elevation, or stations that do not increase;
- a vertical curve is not at an interior PVI, or has a missing or non-positive length or
  radius;
- a curve starts before the previous curve (or the first PVI) ends, or ends after the next
  begins (or the last PVI);
- the profile starts before distance 0 or ends past the end of the horizontal layout by more
  than §11.4's tolerance — an `IfcGradientCurve` cannot run off its base curve.

After mapping, each segment's parameters are evaluated to its end and compared with the
next segment's start, in height and gradient; and the evaluated profile must pass through
every authored point that lies on it: the first and last PVI, and every PVI without a curve.
A curve's own PVI is a tangent intersection, not a point on the profile, so there the check
is that both tangents extended meet at the authored PVI.

### 12.6 Still refused

Sampled (`ProfSurf`) profiles, second and later design profiles of one alignment, profiles
whose stations cannot be placed through their alignment's station equations (§14.5), cant,
superelevation, cross sections and roadways. Each
refused profile is named with its reason in the `profiles` refusal, as alignments are in
§11.

### 12.7 Acceptance

1. **Independent geometry parity.** IfcOpenShell regenerates each vertical `IfcCurveSegment`
   from our `IfcAlignmentVerticalSegment` through `_map_alignment_vertical_segment`, and the
   result must equal ours, and IfcOpenShell's `get_curve_segment_transition_code` must agree
   with every transition code we wrote.
2. **Independent evaluation.** IfcOpenShell's kernel evaluates each of our vertical curve
   segments; its heights at every authored PVI station and at every segment boundary must
   equal the heights the fixture generator computes on its own from the LandXML definition.
3. **Schema conformance.** `ifcopenshell.validate(express_rules=True)` reports 0 issues.
4. **Refusals.** One test per refusal reason in §12.2 and §12.5.

## 13. Cant and superelevation

§11.5 refuses both by count. This section records what IFC 4.3 ADD2 offers for each, why
both stay refused, and the mapping cant follows once its blockers clear. The refusal
messages quote the reasons below (`landxml/cant-superelevation.ts`), and name every written
alignment that carries either record, with its `CantStation` or `Superelevation` block count.

### 13.1 What IFC 4.3 ADD2 offers

| Concept | IFC 4.3 ADD2 carrier | Geometry |
|---|---|---|
| rail cant | `IfcAlignmentCant` (`RailHeadDistance`), nested third under `IfcAlignment` after the horizontal and vertical layouts, nesting `IfcAlignmentSegment` → `IfcAlignmentCantSegment` (`StartDistAlong`, `HorizontalLength`, `StartCantLeft`/`Right`, `EndCantLeft`/`Right`, `PredefinedType` ∈ `CONSTANTCANT`, `LINEARTRANSITION`, `HELMERTCURVE`, `BLOSSCURVE`, `COSINECURVE`, `SINECURVE`, `VIENNESEBEND`) | `IfcSegmentedReferenceCurve` whose `BaseCurve` is the vertical layout's `IfcGradientCurve`, as the alignment's `'Axis'` / `'Curve3D'` |
| road superelevation | no layout entity: `IfcReferent` `.SUPERELEVATIONEVENT.` nested under the alignment, with `Pset_Superelevation` (`Side` ∈ `LEFT`/`RIGHT`/`BOTH`, `Superelevation` as an `IfcRatioMeasure`, `TransitionSuperelevation` ∈ `LINEAR`) | none of its own; a cross slope becomes geometry only through cross-section profiles (`IfcSectionedSolidHorizontal`, `IfcOpenCrossProfileDef`), i.e. roadway modelling |

`IfcAlignmentCant` is a rail concept: its definition is "a lateral inclination profile …
the height relative to the projection of the point along vertical alignment". There is no
road counterpart in ADD2; `Pset_Superelevation` (in the ADD2 property set templates, applicable
to `IfcReferent/SUPERELEVATIONEVENT`) is the recognised carrier for road superelevation events.

### 13.2 Cant — refused, and why

Three blockers were found. The first no longer applies since v1.2; each of the other two is
sufficient on its own:

1. **A vertical layout is required (met since v1.2 for profiled alignments).** IFC 4.3
   permits the layout configurations horizontal; horizontal + vertical; and horizontal +
   vertical + cant (concept template *Alignment Layout – Horizontal, Vertical and Cant*;
   enforced by the buildingSMART validation rule ALB031). Horizontal + cant is not one of
   them, and it cannot be: cant heights are measured from the vertical layout. §12 now writes
   `IfcAlignmentVertical`, so a profiled alignment has one; an alignment without a profile
   still has nothing for a cant layout to stand on.
2. **The geometry has no independent check.** An alignment with a cant layout must be
   represented by an `IfcSegmentedReferenceCurve` (ALB021: an `IfcGradientCurve` axis
   requires the *absence* of a cant layout; ALS008), so cant semantics cannot be written
   without that geometry beside a vertical layout's gradient curve. §11.6's acceptance
   standard is that IfcOpenShell regenerates each curve segment from our semantics and gets
   ours back. For cant it cannot: IfcOpenShell 0.8.5's `_map_alignment_cant_segment`
   derives the segment placement from the *mean* rail height only, so a cant raising the
   left rail and the same cant raising the right rail map to identical geometry; a cant
   rotated about the track centre maps to an untilted axis; and a linear transition into a
   centre-rotated cant raises `ZeroDivisionError`.
   `tools/ifcopenshell_reference/probe_cant_mapping.py` measures all three, and
   `ifcopenshell-conformance.test.ts` asserts them. A pinned-version bump that fixes the
   mapping turns that test red, which is the signal to re-examine this blocker.
3. **`RailHeadDistance` is not in the source.** LandXML's `Cant/@gauge` is "the rail to
   rail distance" (track gauge, 1.435 m standard); IFC's `RailHeadDistance` is the distance
   between the contact-patch centres (about 1.500 m for the same track). Copying one into
   the other overstates every cant angle by about 4.5 %. It needs an operator-supplied value, recorded as
   provenance like the assumed unit (§2.1), or a source that states it.

### 13.3 Cant — the mapping, once unblocked

Written here so the implementation follows a reviewed text, not the other way round.

- **One cant layout per alignment.** `IfcAlignmentCant` nested after the horizontal and
  vertical layouts; one `IfcAlignmentCantSegment` per consecutive pair of `CantStation`s, in
  authored order, plus a zero-length terminating `CONSTANTCANT` segment carrying the last
  station's cant, as for the other layouts.
- **Distance along.** `StartDistAlong = (station − staStart) · linearScaleToMeters`.
  Stations must strictly increase and fall within the horizontal layout's length; an
  alignment with station equations (§11.5) has its cant refused, because a station is then
  not a distance.
- **Units — the trap.** `appliedCant` is in **millimetres** (or inches) by the LandXML 1.2
  schema, not in the declared linear unit: `0.001` (or `0.0254`) converts it to metres, never
  `linearScaleToMeters`. `gauge` *is* in the linear unit.
- **Which rail.** `CantStation/@curvature` is the horizontal curve's direction; the outer
  rail is raised: `cw` (right turn) raises the left rail, `ccw` the right. `adverse="true"`
  raises the inner rail instead.
- **Left and right heights** are rail heights relative to the vertical layout. For an applied
  cant `D` (metres) on the raised rail, by `Cant/@rotationPoint`: `center` → raised `+D/2`,
  other `−D/2`; `insideRail` → inner `0`, outer `+D`; `outsideRail` → outer `0`, inner `−D`;
  `leftRail` / `rightRail` → that rail `0`, the other `±D`. A missing `rotationPoint` refuses
  the cant: there is no default to guess.
- **Segment type.** Equal cant at both ends → `CONSTANTCANT`. Otherwise by the starting
  station's `transitionType`: `clothoid` → `LINEARTRANSITION` (a clothoid carries a linear cant
  ramp), `bloss` → `BLOSSCURVE`, `cosine` → `COSINECURVE`, `sinusoid` → `SINECURVE`. Every
  other `spiralType`, and an absent `transitionType` where the cant changes, refuses the cant
  by name: the ramp shape is the geometry, and guessing it is guessing the track.
- **Carried as properties, not geometry:** `equilibriumCant` and `cantDeficiency` go to
  `Pset_AlignmentCantSegmentCommon` (`CantEquilibrium`, `CantDeficiency`) on the segment that
  starts at that station. Speed stations and the remaining rate attributes are not assigned to
  any property by this mapping and are named in the refusal list.

Acceptance mirrors §11.6: IfcOpenShell regenerates every cant curve segment from our
`IfcAlignmentCantSegment` and gets ours back (blocked today, §13.2 item 2); IfcOpenShell
evaluates the `IfcSegmentedReferenceCurve` and every station lands at the authored rail
heights; `ifcopenshell.validate` reports 0 issues; one test per refusal above.

### 13.4 Superelevation — refused, and why

`Pset_Superelevation` needs, at every event, a cross slope as a ratio and the side it
applies to. LandXML's `Superelevation` gives the event *stations* (`BeginRunoutSta` — normal
crown, `BeginRunoffSta` — half crown, `FullSuperSta`, `RunoffSta`, `StartofRunoutSta`,
`EndofRunoutSta`), one `FullSuperelev` rate and an `AdverseSE` flag. It does not give:

- the **normal-crown slope** at the runout events, which is where half the events sit;
- the **side**, which is implicit in the horizontal curve's direction and the crown shape;
- an **unambiguous scale** for `FullSuperelev`: the 1.2 schema declares it `slope`, "PERCENT",
  while its own `Superelevation` documentation gives the rate as "0.05, or 5%", and producers
  write both.

Writing referents from that would invent two values in three and guess a factor of 100 in
the third. Superelevation therefore stays refused. What would change this: a source that
carries the crown and side explicitly, or roadway and cross-section mapping (§5), where the
cross slope becomes geometry through cross-section profiles rather than a property on an
event.

### 13.5 Acceptance of this section

1. **Precise refusals.** `cant-superelevation.test.ts`: each written alignment carrying cant
   or superelevation is named with its record count and the IFC 4.3 reason; an alignment
   refused whole does not have its cant named again; no `IfcAlignmentCant`,
   `IfcSegmentedReferenceCurve` or superelevation referent is written.
2. **Premise pinned.** `ifcopenshell-conformance.test.ts` runs `probe_cant_mapping.py` and
   asserts the three findings of §13.2 item 2, then validates an export of an alignment
   carrying cant: 0 issues, horizontal layout only.

## 14. Station equations and `CgPoint` referents

v1.3. Up to v1.2, station equations were refused by count, and profiles on alignments that
carry them were refused (§12.2). This section maps both, and answers the question §9.3 left
open: whether a `CgPoint` should become an `IfcReferent` now that alignments exist (§9.3
asked for that to be re-argued rather than inherited). §13 is left free for cant.

### 14.1 Station equations — what is written

A LandXML `StaEquation` says: at this point on the alignment, the displayed station
jumps. `staInternal` is where, measured in the alignment's own continuous stationing
(`staStart` plus the distance along); `staAhead` is the station from there on;
`staBack`, when authored, is the station arriving there; `staIncrement` says whether
stationing increases or decreases after it.

IFC 4.3 carries exactly this on an `IfcReferent`, through `Pset_Stationing` (the
template as IfcOpenShell 0.8.5 ships it, `util/schema/Pset_IFC4X3.ifc`):

| `Pset_Stationing` property | Type | IFC 4.3 definition (abridged) |
|---|---|---|
| `Station` | `IfcLengthMeasure` | the station value at this location |
| `IncomingStation` | `IfcLengthMeasure` | the station of the incoming segment that ends here; "needs to be set if the intention is to specify a station equation" |
| `HasIncreasingStation` | `IfcBoolean` | whether subsequently nested referents have greater (`true`, or absent) or lower (`false`) stations |

For every **written** alignment (§11), each of its station equations becomes:

| LandXML | IFC4X3 |
|---|---|
| `StaEquation` | `IfcReferent`, `PredefinedType = .STATION.`, `Name` = the ahead station as `k+mmm.mmm` |
| distance `(staInternal − staStart)` | `IfcLinearPlacement` → `IfcAxis2PlacementLinear` → `IfcPointByDistanceExpression(DistanceAlong, BasisCurve = the alignment's IfcCompositeCurve)`, with the evaluated point and tangent as its `CartesianPosition`, exactly as the start referent (§11.1) and IfcOpenShell's `add_stationing_referent` write it |
| `staAhead` | `Pset_Stationing.Station` |
| `staBack` | `Pset_Stationing.IncomingStation` — when not authored, the station the running stationing reaches there (below) |
| `staIncrement` | `Pset_Stationing.HasIncreasingStation` (`decreasing` → `false`, `increasing` → `true`); omitted when not authored |

All values are scaled to metres by the declared linear unit, like every other length.
`IncomingStation` is always written, because the property template says a station
equation is *defined* by its presence. Where `staBack` is absent it is derived the way
`rust/landxml`'s `station_mapping` derives the back station: the previous displayed
station (`staStart`, or the previous equation's `staAhead`) plus the distance since it,
times the previous direction (`−1` after a `decreasing` equation). That is the one place
a derived number enters the file, derived by the same rule the viewer already uses to
display stations.

**Nesting.** The equation referents join the start referent in the alignment's single
referent `IfcRelNests`, **ordered by distance along**, start referent first. IfcOpenShell's
`add_stationing_referent` sorts the nest by `Station` instead; for increasing stationing
with forward jumps the two orders agree, but for a backward jump (`staAhead < staBack`) or
decreasing stationing they do not, and it is the order along the alignment that
`HasIncreasingStation` ("subsequently nested referents") is defined against. No
`IfcRelPositions` is written for an equation referent: it positions no product. The
start referent's `IfcRelPositions` to the alignment is unchanged.

**GlobalIds** derive from the equation's own source id
(`landxml:alignment:1:station-equation:1`), §4.3.

### 14.2 Station equations — what is refused

An alignment's station equations are written **all or none**. They are refused — by
name, in the `station-equations` refusal family, with the reason — when any one of them:

- is not a station-equation record with a finite `staInternal` and `staAhead` (and, where
  present, a finite `staBack` and an `increasing`/`decreasing` `staIncrement`);
- lies at or before the alignment's start, or beyond its end, by more than the §11.4
  tolerance;
- is not strictly after the previous equation (the `LXMLA207` rule `rust/landxml` applies).

All-or-none because stationing is cumulative: dropping one equation would make every
station after it wrong while the file looks complete — the argument §11.2 makes for
refusing an alignment whole. The alignment itself is still written; its geometry does not
depend on its stationing, and with its equations refused it is exactly what v1.1 wrote,
with its start station only, which the refusal states.

### 14.3 `CgPoint` referents — re-argued, **still `IfcAnnotation` / `.SURVEY.`**

§9.3 deferred `IfcReferent` for `CgPoint` pending alignments, and asked that the
decision be re-argued when they landed. They have (§11). Re-argued, the decision stands:
a `CgPoint` is written as `IfcAnnotation` / `.SURVEY.` only, and **not** additionally as
an `IfcReferent`. What §9.3 was waiting for is available; what is still missing is in the
source, not in the mapping:

1. **A `CgPoint` carries no alignment and no station.** LandXML gives it a name, code,
   description and coordinates — nothing that ties it to an alignment. An `IfcReferent` is
   a position *along* an alignment (`IfcLinearPlacement` on its basis curve, nested in its
   referent nest). Producing one would mean choosing an alignment (ambiguous in any file
   with more than one) and projecting the point onto it: a station, an offset and an
   alignment membership the source never authored. §1 rules that out: this mapping
   derives, it does not infer.
2. **The points an alignment does reference are not referents.** An alignment's `pntRef`s
   name construction points — segment starts and ends, arc centres, spiral PIs. Starts and
   ends are already the `IfcAlignmentHorizontalSegment` boundaries; centres and PIs are
   not on the alignment at all.
3. **Writing both would double every survey point.** One source record would become two
   IFC products; every consumer counting survey points (and `ifc-lite diff`) would see
   two, against §4.3's one-identity-per-source-record rule.
4. **An unplaced referent adds nothing.** An `IfcReferent` with a local placement and no
   alignment is schema-valid, but it says nothing `IfcAnnotation`/`.SURVEY.` does not, and
   it would give up the comparison with the independent control (§8.2).

The records that *do* map to `IfcReferent` are the ones LandXML places along an
alignment: the start station (§11.1) and station equations (§14.1). Revisit when a
source construct binds a point to a station on a named alignment (a producer's
kilometre-post feature, say); `.REFERENCEMARKER.` or `.KILOPOINT.` would then be the
natural `PredefinedType`.

### 14.5 Profiles on an alignment with station equations

With station equations, station and distance along no longer differ by a constant, so a
profile's stations (§12) must be read through them. LandXML does not say in so many words
whether a `PVI` station is internal (continuous) or displayed; this mapping reads it as the
**displayed** station, the value a designer reads off the stationed alignment, and the one
`rust/landxml`'s `distances_for_station` resolves when the viewer probes a station. Each
authored station is placed where the stationing written in §14.1 displays it:

- exactly one place along the alignment: that distance is the vertex's `StartDistAlong`;
- **none** — the station falls in a forward jump's gap: the profile is refused, naming the
  PVI and the station;
- **more than one** — displayed twice after a backward jump, or by a change of direction:
  the profile is refused, naming the PVI and every distance, because choosing one would be a
  guess.

A profile on an alignment whose equations are refused (§14.2) is refused too: without the
stationing there is nothing to read its stations against. A vertical curve's lengths are
horizontal lengths (§12.4), not station differences, so a curve is laid out in distance
along around its placed PVI whether or not an equation falls inside it.

### 14.4 Acceptance

1. **Independent read-back.** IfcOpenShell reads every referent back from the file:
   the nest must hold the start referent, then the equations in authored order;
   `Pset_Stationing` must carry the authored `Station`, `IncomingStation` and
   `HasIncreasingStation`; and IfcOpenShell's geometry kernel evaluates each referent's
   `DistanceAlong` on our curve, which must land on the point the fixture generator
   computed for that equation independently of the TypeScript — as must the referent's
   `CartesianPosition` (`tools/ifcopenshell_reference/check_referents.py`).
2. **Schema conformance.** `ifcopenshell.validate(express_rules=True)` reports 0 issues on
   the alignment fixture with its station equations (§11.6 item 3).
3. **Refusals.** One test per §14.2 reason, and a test that equations on a written
   alignment are no longer counted as refused.
4. **Profiles through station equations (§14.5).** The fixture's profiled alignment
   carries a station equation and its profile is authored in displayed stations; IfcOpenShell
   must evaluate the written gradient curve to the heights the generator computed along the
   alignment (`check_vertical.py`), and the gap and double-display cases are refused by
   name.

## 15. v1.4 — terrain imagery

v1.4, [#5942](https://github.com/LTplus-AG/ifc-lite/issues/5942). LandXML 1.0–1.2 has no raster
or texture element, so imagery on a terrain can never come from the LandXML file. It comes from
a georeferenced sidecar the operator supplies, and this section defines how the viewer drapes it
and how the IFC4X3 export carries it. An imagery overlay is **provenance, not a claim the LandXML
contained it**: the same rule as `assumedLinearUnit` (§2.1, §7).

### 15.1 Sources

| Source | Placement | CRS | Viewer | Export |
|---|---|---|---|---|
| GeoTIFF | `ModelTiepointTag` + `ModelPixelScaleTag`, or `ModelTransformationTag` | `ProjectedCSTypeGeoKey` / `GeographicTypeGeoKey`, as an EPSG code | draped | shipped as a lossless PNG transcode (§15.5) |
| PNG or JPEG + world file (`.pgw`, `.jgw`, `.pngw`, `.jpgw`, `.wld`) | the world file's six-term affine | a `.prj` or `.aux.xml` WKT carrying an EPSG authority | draped | shipped as the original bytes |
| XYZ tiles or WMS, at a chosen zoom | the tile grid (EPSG:3857), or a WMS 1.1.1 `GetMap` requested in the terrain's own CRS | as requested | draped | **never** (§15.2) |

Every source enters through `useIfcLoader.loadFile`, as every model does. A raster is not a
model, so it creates none: it is draped onto the LandXML terrain models already loaded.

### 15.2 Refusals

Stated up front, in the style of §5. Each is a refusal of the drape, named to the operator; none
is a partial or a guess.

1. **The terrain declares no CRS.** `LandXML/CoordinateSystem` must name an explicit EPSG code
   (the same adapter the federation path uses, `spatialMetadataFromLandXml`). A raster is never
   placed by pixel bounds or by the terrain's extent.
2. **The image has no placement or no CRS.** A PNG/JPEG without a world file, a GeoTIFF without
   a geotransform, and an image whose CRS is absent, user-defined or not an EPSG code are all
   refused. A `.prj` in ESRI form without an `AUTHORITY["EPSG", …]` is refused rather than
   matched by name — that would be the producer-sniffing §2.2 rejects.
3. **The image CRS differs from the terrain's and the operation is not exact.** Reprojection goes
   through the resolver model federation uses (`resolveProjectionOperation`); an unresolvable
   CRS, a missing datum grid, or an operation that only a documented approximation could perform
   is refused, as it is for models.
4. **The image is not planar in the terrain's CRS to within half a pixel.** The UV projection is
   planar (§15.3). A skewed geotransform, or a reprojection whose curvature over the image's
   extent exceeds half a pixel, is refused with the measured deviation.
5. **The image covers no vertex of a terrain.** That terrain is left untouched and named.
6. **An operator-assumed linear unit is allowed.** The projection runs in the terrain's native
   plan coordinates, so the image still lands on the right vertices; but everything the export
   writes in metres, the texture mapping included, inherits the operator's scale. The export
   dialog names the assumed unit next to the imagery.
7. **Tile sources are viewer-only.** Their bytes are not ours to redistribute and their coverage
   depends on the zoom chosen, so a tile drape is never written to an export; the dialog says so.
8. **Budget.** A decoded image above 64 megapixels is refused (it would need gigabytes to
   decode); the viewer downsamples to the device's texture limit and reports the resulting ground
   sample distance; the export ships the image at full resolution.

### 15.3 The projection

One definition, used by the viewer and the export. The image's placement is reduced to the
terrain's horizontal CRS, in its native plan units, as

- `O`, the plan position of the image's **bottom-left corner**;
- `U`, the unit vector along the image's columns (left to right);
- `V`, the unit vector up the image (bottom to top), perpendicular to `U`;
- `W`, `H`, the image's extent along `U` and `V`.

A vertex at plan position `P = (easting, northing)` — the same axis contract as §2.2 and §4.1 —
maps to

```
u = (P − O) · U / W
v = (P − O) · V / H
```

with the texture origin at the bottom-left, which is the `IfcTextureVertexList` convention. The
viewer's GPU convention is top-left, so it uses `1 − v`. A vertex is **covered** when
`0 ≤ u ≤ 1` and `0 ≤ v ≤ 1`, and the **covered fraction** of a surface is the fraction of its TIN
vertices — those referenced by at least one rendered (viewer) or written (export) face — that
are covered.

Two traps, both pinned by tests:

- **Half a pixel.** A world file's translation terms name the *centre* of the upper-left pixel;
  a GeoTIFF tie point under the default `RasterPixelIsArea` names its *corner*, and under
  `RasterPixelIsPoint` its centre. All three are normalised to the corner before `O` is formed.
  Getting this wrong shifts the image by half a pixel, which at an orthophoto's resolution is
  invisible on screen and wrong in every measurement.
- **Coordinate order, twice.** World files and geotransforms are authored as
  `(x = easting, y = northing)`; LandXML point text is northing-first (§2.2). The drape reads each
  terrain vertex as `(easting, northing)`, exactly as the mesh does, and never reorders the image.
  An easting-first terrain under a correctly placed image is therefore mirrored against it across
  the line `easting = northing`, which is the visual that makes that defect visible.

When the image CRS differs from the terrain's, the image's placement is carried into the
terrain's CRS by reprojecting a grid of points spanning the image and fitting the affine above
by least squares. The fit's largest residual, and the largest departure of the fitted affine
from an orthogonal one (a planar mapping carries no skew), are measured in image pixels; either
above one half is refusal 4.

### 15.4 Viewer drape

- Each draped mesh keeps its geometry. Per vertex it gains `(u, 1 − v)`, computed from the
  vertex's **source** plan position: the rendered position is carried back to the source frame
  (through the pre-alignment snapshot when the model was federated) and snapped to the surface's
  own TIN point. A vertex with no TIN point within tolerance refuses the drape rather than
  guessing.
- It renders through the existing textured-mesh path (`MeshData.textureRef` + `textureBitmap`,
  one GPU texture per `textureId`).
- **Outside the extent, the flat terrain colour.** The uploaded bitmap carries a one-pixel border
  in the terrain's flat colour and samples with clamp-to-edge; the mesh colour becomes white so
  the image is not tinted. A covered fragment shows the image, an uncovered one the border — the
  flat colour — and the change happens at the image's edge, not at the nearest vertex.
- The model's card in the properties panel reports the source, its CRS, the ground sample
  distance and the covered fraction.

### 15.5 Export (IFC4X3)

For each draped surface whose imagery came from a file (§15.1):

| What | IFC4X3 |
|---|---|
| the image | `IfcImageTexture`: `RepeatS = .F.`, `RepeatT = .F.`, `URLReference` = the image's entry name in the `.ifcZIP` |
| its style | `IfcSurfaceStyle` (`.BOTH.`) of `IfcSurfaceStyleShading` (white) and `IfcSurfaceStyleWithTextures`, bound to the TIN by an `IfcStyledItem` |
| the UVs | one `IfcTextureVertexList` row per TIN vertex (§15.3), bound by an `IfcIndexedTriangleTextureMap` whose `MappedTo` is the `IfcTriangulatedIrregularNetwork` and whose `TexCoordIndex` repeats the TIN's `CoordIndex` |

`IfcIndexedTriangleTextureMap` is the concrete subtype of the abstract `IfcIndexedTextureMap`
the issue names. `IfcTriangulatedIrregularNetwork` is a subtype of `IfcTriangulatedFaceSet`
with the same attributes at positions 0–4, so the shape is the one the appearance workspace
writes for building elements, and it is written **by the appearance workspace's planner**
(`plan_appearance`, `planar` mapping in the `world` frame, with `O`, `U`, `V`, `W`, `H` scaled to
metres). There is no second texture writer. The TIN written by §4.1 is unchanged: same vertices,
same triangles, same `Flags`.

- **Outside the extent.** `IfcIndexedTriangleTextureMap` maps every triangle of its face set, and
  `RepeatS = .F.` clamps coordinates to the image, so a consumer shows the image's edge pixels
  across an uncovered part. The viewer's flat fallback cannot be expressed on one face set
  without splitting the TIN, which §4.1's one-TIN-per-surface rule and the round-trip acceptance
  forbid. The UVs are the exact georeferenced values, not clamped ones, and the covered fraction
  is recorded (below), so a consumer can tell.
- **Packaging.** The file becomes an `.ifcZIP`: the STEP entry and the image entry side by side,
  the image stored uncompressed, and `URLReference` the image's entry name — resolved on load by
  basename, as `textureResources.ts` resolves every `.ifcZIP` texture. PNG and JPEG ship as their
  original bytes; a GeoTIFF ships as a lossless PNG transcode, because neither browsers nor most
  IFC consumers decode TIFF.
- **Provenance.** `LandXML_Conversion` (§7) gains: `ImagerySourceFileName`, `ImagerySourceHash`
  (SHA-256 of the image bytes as supplied), `ImageryPlacement` (`world file` or `GeoTIFF`),
  `ImageryCrs` (as declared), `ImageryProjection` (`O`, `U`, `V`, `W`, `H` in the terrain CRS),
  `ImageryCoveredFraction`, and, for a transcode, `ImageryShippedFileName` and
  `ImageryShippedHash`. They are written only when imagery is exported.
- **Refused.** A tile drape (§15.2 item 7) exports the terrain untextured, and the dialog says
  so before the user commits.

### 15.6 Acceptance

1. **Coordinate order.** A terrain whose point text is easting-first, under a correctly placed
   image, lands its marked vertex on the mirrored pixel, not the marked one.
2. **Projection.** UVs at known coordinates for a north-up world file, a rotated one and a
   GeoTIFF under both raster types; the half-pixel normalisation; the reprojection fit's refusal.
3. **Independent read-back.** IfcOpenShell reopens the exported `.ifcZIP`, validates it with
   `express_rules=True`, and resolves the texture on the TIN's faces: the texture map's
   `MappedTo` is the TIN, its `URLReference` resolves to an entry of the archive, and the UV at a
   marked vertex lands on the marked pixel of the shipped image.
4. **Real data.** A real orthophoto and TIN pair from the reviewed producer corpus, with a
   surveyed feature visible in both, whose draped pixel and TIN vertex coincide within the
   image's ground sample distance. **Owed**: the fixture corpus holds no such pair yet, so items
   1–3 stand on synthetic, known-georeferenced data (§8's rule: a synthetic fixture proves an
   invariant and certifies no producer).
