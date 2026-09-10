# Captured mesh authoring

Implementation contract for F5, tracked by #4380. The viewer exposes captured
surface creation inside Author → Appearance → Create from scan.

## User workflow

Load a textured capture through the existing Open/Add path. From its Appearance
workspace choose **Create from scan**, align the capture in the workspace, select
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

The GLB path converges through `parseGlbViewerModel`. The capture decoder
preserves source UVs, original embedded albedo PNG/JPEG images, and node matrix
or translation/rotation/scale transforms. Unsupported PBR maps and alpha
modes are explicitly refused; see [capture evidence](evidence/captured-glb/README.md).

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

## Shared host implementation

`prepareTexturedProduct` serializes the effective IFC mutation view and captures
its allocation/revision guard once for both annotations and captured surfaces.
`commitTexturedProduct` owns publication, containment, original-image retention,
selection cleanup on Undo and stable identity on Redo. Drawing creation uses the
same transaction; there is no independent scan STEP writer.

`prepareCapturedRegion` binds a selected triangle region to its registered raw
model geometry and one unambiguous retained original image. It preserves source
sampling flags and converts GPU V coordinates once. `createIfcFromCapturedMesh`
owns a bounded numeric snapshot before its first await, converts workspace
coordinates into the destination model frame, and sends that snapshot to the
native planner. It revalidates registration and target state before publication.

The integrated capture panel uses an independent instance of the existing
renderer to preview the retained original image and selected source triangles.
Orbit and zoom affect only that preview. A through-surface screen rectangle
selects whole triangles by projected centroid; it never synthesizes border cuts.
Preview graphics failure disables Create and offers a local preview reload.
The original model, image/PDF draft controls, and main camera remain independent.

Actual WebGPU creation, original-image export, normal re-import, and picking are
recorded in [captured UI acceptance](evidence/captured-ui/README.md).

Destination eligibility is independent of load order or prior object selection: a loaded IFC4/IFC4X3 spatial model is offered even before its lazy mutation view exists. Creation initializes or reuses the canonical view, preserving prior edits. The created object activates its destination model so the shared Undo action targets that creation. Drawing-to-IfcAnnotation creation uses the same destination and selection helpers.

The native shared creator obtains metadata validation, the effective source
context, allocation preflight and container-relative placement from
`appearance/authored.rs`. Texture-specific row construction and canonical mesh
production remain in the existing annotation/captured planner. This extraction
does not change the public creator APIs or enable additional representations.
