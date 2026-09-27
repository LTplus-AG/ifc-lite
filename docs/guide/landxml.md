# LandXML

ifc-lite loads LandXML surveying and infrastructure data natively and federates it alongside
IFC models and point clouds. LandXML records stay LandXML — **no `Ifc*` entities are invented
from them**.

This page describes what loads, what is kept but not drawn, what is refused, and what export
does. For the evidence behind interoperability claims, see the
[coverage ledger](../architecture/landxml-coverage-ledger.md); a capability being implemented
is recorded separately there from whether a given producer's export has been verified.

## Opening a file

Drop a `.xml` file into the viewer, or add it as a federated model. It goes through the same
`loadFile` path as every other format, so federation, selection, and the properties panel work
the same way.

Schema versions 1.0, 1.1 and 1.2 are recognised by namespace:

```
http://www.landxml.org/schema/LandXML-1.0
http://www.landxml.org/schema/LandXML-1.1
http://www.landxml.org/schema/LandXML-1.2
```

A file whose root element or namespace is not one of these is refused — a generic `.xml` is not
assumed to be LandXML just because of its extension.

Vendor profiles that merely reuse the LandXML namespace are **not** silently reinterpreted as
ordinary LandXML. InfraModel is refused explicitly rather than partially parsed.

## What is drawn

Triangulated surfaces (`Surfaces/Surface` with `Definition surfType="TIN"`) are meshed and
rendered, both when the producer authored `Faces` and when a boundary/breakline definition can be
deterministically triangulated.

## What is kept but not drawn

These are parsed, preserved with stable source identities, and inspectable in the properties
panel under **LandXML Source**, but the viewer does not draw them:

- horizontal alignments, stationing, cant and superelevation (IFC export writes horizontal
  alignments as `IfcAlignment`, see [Export](#export); cant and superelevation are not exported)
- profiles, vertical curves, roadways and cross-sections
- COGO points, monuments, parcels and plan features
- pipe networks, structures and pipes

This is deliberate. A preserved record is honest about what the file said; a fabricated one is
not. Alignments can be probed numerically (station, offset, elevation) without being drawn.

## Units are required for anything renderable

LandXML 1.2 makes `<Units>` mandatory. ifc-lite enforces that for any surface it would otherwise
render:

```
LXML009: a numeric, renderable TIN surface requires a LandXML/Units element
         with a linearUnit attribute
```

The rule is applied identically on every parse path, streaming and non-streaming, so a file
cannot render on one path and be refused on another.

A unitless file is **not** rejected outright: surfaces that would only ever be preserved-only
remain inspectable. Only a numeric surface that would be drawn to scale needs a declared unit,
because drawing it to scale is precisely what cannot be done without one.

!!! note "Producers that omit `<Units>`"

    Some exporters emit no `<Units>` element at all, which makes their output invalid against the
    LandXML 1.2 schema. The unit is never guessed from coordinate magnitude. If you control the
    exporter, emitting `<Units>` is the fix.

## Coordinate order

LandXML point text is **northing, easting, elevation** — not X, Y, Z. ifc-lite reads it that way.

A file that writes easting first still loads and still produces a well-formed mesh, because a
transposition is a reflection. It will be placed and oriented wrongly against any correctly
georeferenced model, and no count-based check will notice. If terrain appears mirrored or lands
in the wrong place relative to a federated IFC model, compare a point's coordinates against the
file's declared CRS before assuming a renderer fault.

## Georeferencing and federation

A declared `CoordinateSystem` is carried through the format-neutral georeferencing contract, so
LandXML, IFC and point-cloud sources can be placed in one coordinate frame. Horizontal and
vertical references are tracked separately, and an unresolvable reference is an explicit refusal
rather than a silent identity transform.

## Export

A LandXML model can be converted to IFC4X3, under the reviewed mapping in
[LandXML → IFC mapping](../architecture/landxml-to-ifc-mapping.md) (v1.0). The conversion is
one-way and derived: it is not a round trip, and it does not replace the source records, which
remain the authoritative model in the viewer.

What v1 writes:

| LandXML record | IFC4X3 |
|---|---|
| A renderable TIN `Surface` | `IfcGeographicElement` / `.TERRAIN.` carrying an `IfcTriangulatedIrregularNetwork` |
| A `CgPoint` | `IfcAnnotation` / `.SURVEY.` with a property set |
| A horizontal `Alignment` (lines, circular arcs, clothoid spirals) | `IfcAlignment` with its horizontal layout, geometry and start station |
| A declared `CoordinateSystem` | `IfcProjectedCRS` + `IfcMapConversion` |

An alignment is written only when **every** segment is a line, circular arc or clothoid, each
segment reproduces its authored end point, and consecutive segments meet. Anything else (an
`IrregularLine`, another spiral type, an unresolved point reference, a gap) refuses that alignment
whole, naming the segment and the reason. A gap would make every later station wrong, so a partial
alignment is never written.

Everything else — vertical profiles, cant, superelevation, station equations, cross sections,
roadways, parcels, monuments, plan features, pipe networks, and a surface's breaklines, boundaries
and contours — is **named in the export dialog before you commit**, by record family and count. A
partial export is allowed; a silent partial is not.

The dialog refuses outright when nothing in the file is covered, rather than producing a valid,
empty, useless IFC. It also refuses when the target schema is not IFC4X3: the mapping derives
IFC4X3 STEP only (declared as `IFC4X3_ADD2`, the ISO 16739-1:2024 identifier), so IFC5/IFCX is not
a conversion target.

Two things the dialog states because the geometry cannot:

- **An assumed linear unit.** If the source declares no `<Units>` and you supplied one at load
  time, every coordinate is at that operator-chosen scale. The IFC records the assumption in a
  `LandXML_Conversion` property set on the site.
- **The coordinate reference system.** With no declared CRS, no georeferencing is written at all
  (rather than a placeholder). With one, the declared datum is written verbatim as
  `IfcProjectedCRS.Name` — ifc-lite never resolves it to an EPSG definition — and the
  coordinate-order plausibility check still cannot run, because it needs that CRS's coordinate
  bounds. A source whose point text was written easting-first produces a mirrored surface that
  still renders and still passes every count check, so verify the source before relying on the
  position.

Also available, and still the recommended route when a downstream tool can read the source:

- **Download the original LandXML.** The export dialog offers the source file back, unchanged.
- **Changes only (JSON delta)** export. Mutation deltas are source-independent JSON, not synthesised IFC, so
  the mapping does not apply to them.

## Diagnostics

Parse failures carry a stable code:

| Code | Meaning |
| --- | --- |
| `LXML001` | input exceeds the configured byte limit |
| `LXML002` | `DOCTYPE` is not allowed |
| `LXML003` | unknown XML entity reference |
| `LXML004` | a bounded resource ceiling was hit (depth, text, attribute, token) |
| `LXML005` | ingestion cancelled by the host |
| `LXML006` | malformed or undecodable XML |
| `LXML007` | root namespace is not a recognised LandXML namespace |
| `LXML008` | recognised namespace with an unknown `version` |
| `LXML009` | a required attribute or element is missing, or content is semantically invalid |

Terrain triangulation refusals use a separate `LXMLT###` family, and alignment numeric evaluation
uses `LXMLA###`. Both are reported as diagnostics on the model rather than as load failures, so a
file that cannot be triangulated still opens with its source records intact.

## Out of scope

Native LandXML authoring and export, survey adjustment, hydraulic analysis, cadastral
certification, and corridor reconstruction from unsupported records.
