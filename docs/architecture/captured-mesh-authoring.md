# Captured mesh authoring

Implementation contract for F5, tracked by #4380. This document describes the
next slice; it does not claim that capture creation is enabled in the viewer.

## User workflow

Load a textured capture through the existing Open/Add path. From its Appearance
source choose **Create from region**, align the capture in the workspace, select
a bounded region, and preview the resulting surface. Choose the destination IFC
model and spatial container, then enter its Name. The initial semantic class is
`IfcBuildingElementProxy`: captured surface geometry does not establish wall,
slab, opening, material, or structural semantics.

Create publishes IFC entities, geometry, image ownership, containment and history
as one transaction. The source remains independently available. Cancel or stale
registration leaves no authored geometry or entities. Undo clears selection of
the removed object; Redo restores its identity and appearance.

## Canonical boundaries

- Capture files enter `useIfcLoader.loadFile(file, target)`. A capture-specific
  panel must not introduce another model-loading path.
- Decode source geometry and retain the encoded image resources with their
  source lineage. Registration remains separate from file coordinates and from
  the chosen destination model's placement.
- The native captured-mesh planner receives bounded IFC world metre coordinates,
  geometry indices, UV coordinates and independent UV indices. The adapter
  converts source coordinates and UV origin conventions exactly once. UV seams
  must survive even where several UV vertices share one geometry vertex.
- Native planning resolves destination units, inverse spatial placement, IFC
  schema attributes and entity allocation. Reuse the existing appearance entity
  plan and `produce_element_meshes` path rather than constructing STEP text or a
  second preview tessellation in JavaScript.
- The viewer transaction reuses the detached textured-owner insertion, source
  guards, asset inventory, containment helpers and history used by annotation
  creation. Multi-part geometry must retain one IFC object identity.

## Input fidelity prerequisite

The existing GLB path already converges through `parseGlbViewerModel`, but its
current cache decoder only reads POSITION/NORMAL/indices and a material colour.
It drops texture coordinates and embedded images. Its node transform support
also needs qualification against capture files: translation and matrix support
do not establish support for all glTF rotation/scale representations.

Extend that canonical decoder or replace it in the same path; do not hide this
gap by requiring users to convert their captures to IFC first. Unsupported
material, UV or transform features must produce an explicit diagnostic before
creation. A textured viewport image alone cannot certify that source UVs,
encoded images and registration survive the authoring boundary.

The existing offline OBJ/MTL boulder adapter and IfcOpenShell writer are oracle
experiments. They provide licensed source fixtures and independent comparison;
they are not the production IFC implementation.

## Acceptance

Use the real licensed public boulder capture and retain its source digest and
license. Inspect a cropped result at a UV seam and compare source image samples.
Verify actual hierarchy and viewport selection in one- and multi-model scenes,
Name/class and spatial containment, cancellation and stale-result rejection,
Undo/Redo, ordinary and subset IFCZIP, and fresh shared-room viewing. Validate
exported IFC using an independent reader. Record resource limits and observed
preparation/cancellation latency; do not claim reconstruction or watertightness
from creation of an existing captured surface.

F4 transfer accuracy and F9/F10 reconstruction retain their independent real-data
and quality gates. They are not prerequisites for creating an existing textured
mesh region.
