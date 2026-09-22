<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# LandXML → IFC mapping specification (v1, proposed)

Status: **proposed — not implemented**. Version 0.1, 2026-09-22.
Issues: [#5175](https://github.com/LTplus-AG/ifc-lite/issues/5175) (export honesty),
[#4937](https://github.com/LTplus-AG/ifc-lite/issues/4937) (native LandXML).

This document exists because #5175 requires that an opt-in LandXML→IFC mapping be
*defined and reviewed before it is built*, rather than an implicit `Ifc*` projection
invented to satisfy an export button. Nothing here ships until this document is
reviewed and accepted.

Until then the current behaviour stands and is correct: the viewer refuses IFC export
for any model whose `sourceSchema` is LandXML, for both the selected and the merged
scope (`apps/viewer/src/components/viewer/ExportDialog.tsx`, pinned by
`ExportDialog.landxml.test.tsx`).

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

Recommended, in the exporter's pre-flight and in the loader:

1. When a CRS is declared, test the coordinates against that CRS's valid easting/northing ranges
   and refuse (or warn prominently) when the values can only be the other way round. For
   EPSG:3006 a 6.4-million value can only be a northing.
2. Offer an explicit, user-confirmed "swap northing/easting" toggle, recorded as provenance
   exactly like the units override, for operators who must consume a known-faulty source.
3. **Rejected:** producer-sniffing on `Project/Application/@name` — unmaintainable, and it
   encodes one tool's bug as a rule.

Never infer the order from coordinate magnitude without a declared CRS to bound the test.

## 3. Target schema

IFC4X3. Note that the repo's exporter tag is `IFC4X3`; `IFC4X3_ADD2` (what
IfcOpenShell 0.8.0 writes, and what the bonsai files declare) is not an exporter tag
here — see `packages/export/src/attribute-real-slots.ts`. All entity and attribute
definitions below were taken from `packages/codegen/schemas/IFC4X3.exp`.

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
unchanged source produces an unchanged file and `ifc-lite diff` is meaningful. Use the
existing deterministic GUID helper; do not mint random GUIDs. The source id is already
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

## 9. Open questions for review

1. §2.2 — is the CRS-range plausibility check in scope for v1, or a separate hardening issue?
2. Is `IfcGeographicElement`/`.TERRAIN.` the right carrier, or should terrain hang off
   `IfcSite` directly? `IfcSite` can carry its own representation; using it would avoid
   an element with no real-world counterpart, but loses the ability to carry several
   named surfaces from one file.
3. Should `CgPoint` become `IfcAnnotation`/`.SURVEY.` (matches the observed control) or
   `IfcReferent` (arguably more correct for survey control in IFC4X3)? v1 proposes
   `IfcAnnotation` specifically because it is what the available control uses.
4. Is a mapping that cannot represent alignments worth shipping, given that two of the
   reviewed producer fixtures are alignment-only and would export nothing?
