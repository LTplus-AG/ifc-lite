# Real scan/IFC acceptance data — #4381

CRAS is a downloaded, licensed **candidate**, not a passed registration or
appearance-transfer acceptance test. The independent check-point gate remains
open. [Inspection manifest](cras-source-inspection.json) contains measured source
identity, units, component counts and bounded scan-prefix statistics.

## Provenance and acquisition

The authors' [Zenodo record](https://zenodo.org/records/7948116) pairs a real RGB
laser capture with an as-built IFC of the same CRAS laboratory. The record's
[API metadata](https://zenodo.org/api/records/7948116) declares CC BY 4.0. Retain
attribution to Nuno Abreu and collaborators, the record DOI, license and every
crop/normal-estimation/registration operation in derived samples. Metadata was
queried directly during this inspection; no gated access agreement was accepted.

The complete IFC was downloaded and its published MD5 verified. Its SHA-256 is
pinned in the manifest. Independent IfcOpenShell 0.8.5 parsing finds IFC2X3,
metre units, 61 walls, five slabs, six doors and 44 windows. An IFC4-only writer
must explicitly handle this schema difference before claiming this sample works.
Site/building placements are identity, but that says nothing about the scan's
registration. Storey TÉRREO has a 0.1 m Z placement.

The scan ZIP directory contains one 26,752,658,348-byte ASCII member. HTTP Range
requests fetched the final 65,536 archive bytes and the first 1,048,576 bytes.
Raw DEFLATE decoding after the local ZIP header, discarding the incomplete final
line, produced 137,887 complete source points. Their XYZ/RGB/intensity/label rows
are unchanged. All prefix labels are zero; this is file-order sampling, **not**
a selected room, representative wall coverage, or a semantic benchmark. The
complete 4.27 GB ZIP was not downloaded: its published checksum remains unverified.
A range digest cannot establish integrity of bytes that were never fetched.

Local artifacts (outside Git):

- `/tmp/ifclite-public-captures/original/craslabbim.ifc`
- `/tmp/ifclite-public-captures/cras-scan-prefix.txt`
- `/tmp/ifclite-public-captures/cras-record-current.json`
- `/tmp/ifclite-public-captures/cras-zip-tail.bin`

Downloads are available through `https://zenodo.org/api/records/7948116/files/`
followed by `craslabbim.ifc/content` or `craslabannotated.zip/content`.
No binary fixture is committed. Any eventual CI fixture must follow the existing
fixture manifest/upload flow, preserving attribution and explicit crop provenance.

## Why the acceptance gate is still open

The [dataset paper, section 6.2](https://www.mdpi.com/2306-5729/8/6/101)
describes a separate coarse-to-fine ICP registration from capture to BIM. The
reported 3 mm figure concerns registration among laser scans; it is **not** a
measured scan-to-IFC error. Neither the downloaded IFC nor the inspected archive
directory supplies independent corresponding survey check points. There is no
verified scan-to-IFC transform in this evidence. Identity is deliberately absent
from the manifest, rather than guessed from metre units or similar bounds.

The record exposes only IFC and one ASCII scan archive, with no distinct
registration/check-point file. That establishes the absence of a separate file
in this record, not the absence of survey evidence everywhere. Visual matching,
ICP fit residuals, or landmarks used to solve the transform must not be relabeled
as independent surveyed accuracy.

## Concrete remaining acceptance protocol

1. Acquire a bounded spatial crop covering several identifiable building corners,
   retaining original source row indices and exact bounds. File-order prefix alone
   is insufficient; stream the full verified archive or use another documented crop.
2. Identify fitting landmarks separately from spatially distributed held-out
   check landmarks. Record who identified them, both coordinate triples, feature
   interpretation and measurement uncertainty. Manually corresponding corners are
   independent of the fit but are not independently surveyed control points.
3. Fit and freeze the proper rigid/uniform-scale transform on fitting points only.
   Publish held-out residual vectors and metric summary before choosing bake
   tolerances. Do not optimize on check points or select only convenient walls.
4. Establish oriented normals with a documented neighborhood and orientation
   method; this ASCII source contains no normals or per-point scanner origins.
   Reject ambiguous orientations rather than accepting opposite wall faces.
5. Run appearance transfer on the same registered IFC/crop, report unknown area,
   thin-wall bleed and image sampling limits, then verify identity, Undo/Redo,
   independent IFC reopening and room sharing. Capture color is measured; missing
   areas remain explicitly unknown. No quality claim is made by this inspection.

This preparation makes real source bytes available for importer work while
keeping registration evidence as an explicit unfinished deliverable.

## Bounded alternatives check

Three additional primary inventories were inspected before returning to CRAS:

| Candidate | Observed artifacts | Decision for this appearance gate |
| --- | --- | --- |
| [SUM4Re, record 19678608](https://zenodo.org/records/19678608) | API declares CC BY 4.0 and lists 20 LAZ files. Although the description mentions target IFC models, this version's file list contains no IFC or check-point file. | Promising real sensor data; cannot infer an available pair from the description. |
| [HePIC authors' repository](https://github.com/LTTM/Scan-to-BIM) and linked public Drive | Recursive listing contains 79 `.txt`/`.md` files. The downloaded dataset README declares CC BY-SA 4.0 and specifies XYZ, class name and instance number. No RGB or IFC is listed. | Useful semantic research; selected release is not an appearance-transfer pair. |
| [Kladno, record 14221915](https://zenodo.org/records/14221915) | CC BY 4.0; one 6,513,510,452-byte LAS file, no IFC or check-point file. | A downstream predicted IFC is not independent paired ground truth. |

These findings concern the inspected releases, not an assertion that authors
possess no additional files. No requests were sent to authors.

## Bounded spatial crop now available

`/tmp/ifclite-public-captures/cras-spatial-crop.tsv` contains 41,697 unchanged
RGB points within source-metre bounds `[5,14,-1]` to `[6.7,16.4,1.7]`, with their
zero-based original data-row index prepended. It is 2,155,293 bytes. The adjacent
JSON records its SHA-256, compressed byte-range digest and processing bounds.
This is a spatial filter over 2,112,397 complete rows decoded from the first
16 MiB of the archive, **not** a complete-archive spatial query. No downsampling
was necessary. The box was chosen in scan coordinates, without claiming a
matching IFC room or pre-solving registration. It is usable for RGB import and
manual correspondence exploration; completeness, normals and registration remain
unestablished. Preserve that limitation in any derived PLY or acceptance report.

The accompanying `cras-spatial-crop.ply` is a 1.66 MB ASCII RGB PLY preserving
source coordinates and row index. It carries no guessed normals. Orthographic
inspection of this crop shows disconnected narrow surface patches near X=6.5 m,
Z=1.35–1.67 m, rather than reliably identifiable building corners. Consequently
no fitting or check-point coordinates have been fabricated for it. A manual
registration session needs a broader acquisition containing matched structural
features before this gate can advance.

For that session, reserve at least four distributed structural intersections
(e.g. wall-wall-floor corners or well-defined jamb/lintel corners) for fitting,
and at least four different intersections for checks, including different heights
and separated room locations. Freeze the two feature-ID lists and tolerance before
solving. Store scan point indices or fitted local plane neighborhoods, IFC GlobalId
and representation-derived corner definition, chosen position and selection
uncertainty for each. Reject a feature if clutter or an unmodeled offset prevents
an unambiguous match. Held-out manual agreement measures consistency with those
correspondences; it does not establish survey-grade absolute accuracy.

## IFC4 schema derivative

The source can be migrated with the existing IfcOpenShell schema migrator;
this is a derivative of the published IFC, not a BIM invented from scan points:

```python
import ifcopenshell
from ifcopenshell.util.schema import Migrator

original = ifcopenshell.open("craslabbim.ifc")
derived = ifcopenshell.file(schema="IFC4")
migrator = Migrator()
for entity in original:
    migrator.migrate(entity, derived)
derived.write("craslabbim-ifc4.ifc")
```

The inspected run used IfcOpenShell 0.8.5. Migration prints notices for target
attributes that have no source equivalent; this is not a general guarantee of
lossless property/schema migration. EXPRESS IDs are reassigned. A preserved
GlobalId set and matched tessellation do not certify every IFC relationship or
material property. Both the source and derivative must remain available.

The inspected derivative is available at
`/tmp/ifclite-public-captures/derived/craslabbim-ifc4.ifc` (66,261,284 bytes).
[Migration evidence](cras-ifc4-migration.json) pins both hashes. All 2,414 source
IfcRoot GlobalIds are preserved. Independent reopening and world-coordinate
geometry generation checked every represented IfcBuildingElement: 136 objects,
590,643 nonempty source vertices. Of these, 134 have exact vertex/index arrays;
two walls reorder vertices/triangles. Canonicalizing only cyclic corner rotations
and triangle order, preserving winding and applying no rounding, proves those
two oriented triangle sets exactly equal as well. The raw 18 m array-index delta
is a reordering artifact, not a geometric displacement. This establishes the
checked building geometry, not a blanket migration-fidelity claim.

IfcOpenShell schema/cardinality validation reports zero errors; EXPRESS rules
were not run. The first geometry comparison attempt was rejected because temporary
native shape handles yielded empty arrays. The accepted run retains both shape
handles and asserts every original mesh is nonempty before comparison.

This IFC4 derivative removes the source-schema obstacle for an appearance
experiment. It does **not** supply the still-missing scan registration, normals,
full spatial coverage or held-out feature correspondences.
