<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# LandXML → IFC mapping specification (v1, proposed)

Status: **accepted — v1 implemented; v1.1 (horizontal alignments, §11) implemented**.
Version 1.1, 2026-09-24.
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
`FILE_SCHEMA(('IFC4X3_ADD2'))` through `ProjectParams.FileSchemaIdentifier` (§11). The
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

Vertical profiles (`IfcAlignmentVertical`), cant, superelevation, station equations,
cross sections and roadways. Each is named with its count, as in §5. `IfcReferent` for
`CgPoint` (§9.3) stays deferred: v1.1 writes a station referent for the alignment start
only.

### 11.6 Acceptance

1. **Independent geometry parity.** IfcOpenShell regenerates each `IfcCurveSegment` from our
   `IfcAlignmentHorizontalSegment` through its own mapping, and the result must equal ours.
2. **Independent evaluation.** IfcOpenShell evaluates our composite curve; every segment
   boundary must land on the LandXML-authored point.
3. **Schema conformance.** `ifcopenshell.validate(express_rules=True)`, as §3 requires.
4. **Refusals.** One test per refusal reason in §11.2 and §11.4.
