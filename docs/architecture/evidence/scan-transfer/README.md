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
