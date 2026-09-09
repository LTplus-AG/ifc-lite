# Scan alignment workbench

The Appearance workspace's **Align scan** stage matches a loaded textured GLB
surface to visible surfaces of a loaded IFC4/IFC4X3 model. Open both through the
normal Open/Add model controls, choose the source surface and IFC destination,
and click each source landmark in the preview followed by its corresponding IFC
point in the main view. Orbit and zoom remain available in both views.

Use well-distributed **Fit** landmarks to estimate a rigid transform, and choose
**Check** landmarks independently. Calculate alignment reports each point's
error, separate fit/check RMS and maximum errors, and the source spread ratio.
Three non-collinear fit points suffice mathematically; at least four fit and four
independent check pairs are the operational prerequisite before using a recipe
for transfer. Neither count nor a successful solve approves accuracy. Inspect
errors against project tolerances and spatial coverage, including depth and
opposite surfaces where relevant.

**Preview alignment** applies the returned native rotation and anchors to owned
preview buffers. Paired scan and IFC markers expose residual differences. The
loaded source model and IFC are unchanged by alignment preview. The same panel
then offers **Transfer scan appearance** for an explicitly chosen IFC object
scope. It does not reconstruct geometry or persist a reusable recipe. The draft
belongs to the mounted panel; switching to another Appearance action discards
the landmark pairs.

## Observation and frame contract

The source comes from canonical GLB ingestion. An observation records the
original decoded surface ordinal, triangle ordinal and barycentric weights
(`A:w`, `B:u`, `C:v`), evaluated in original GLB scene Y-up metres, including the
retained mesh origin. It is bound to the SHA-256 of the original source file.
The preview never substitutes a newly ingested or reconstructed source.

The IFC feature records GlobalId, retained piece/item identity, triangle and
barycentric weights. Picking first resolves the visible owner and then raycasts
its retained concrete pieces. Target coordinates use the explicitly named
`workspace-ifc-z-up-metres` frame: viewer origin offsets are restored and
committed workspace model placement is included. The transfer adapter supplies the explicit native IFC-world-to-this-frame
translation from canonical model offsets and committed placement. IFC parent
rotations are already part of native geometry; camera building-rotation metadata
is not applied a second time. CRS-realigned destinations are currently refused. Source and target frame identities, effective IFC
content hash, placement state and mutation revision are frozen together.

The existing appearance worker calls Rust's `registerScanCorrespondences`.
TypeScript only applies the resulting anchored rotation for display. The
immutable request/report pair retains the native request digest; JavaScript does
not recompute Rust's typed-JSON digest. Fit and check inputs remain disjoint, and
checks do not influence fitting.

## Bounds and recovery

The first adapter supports one textured GLB surface with at most 200,000 vertices
and triangles, files below 128 MiB, and at most 256 pairs in each partition.
Retained target pieces across picked landmarks share a 200,000 vertex/triangle
budget. Instanced or aggregated target geometry without stable retained concrete
triangles is refused. Source coordinates/UVs and paired target geometry are
snapshotted and checked before solving and after worker completion.

Changing a source, target, placement or effective IFC invalidates the frozen
binding. A known appearance Apply retains the pairs only after proving ordered
triangle-corner geometry and frames unchanged, then reserializes the effective
IFC and recalculates the native registration digest. Undo/Redo requires explicit
**Revalidate retained landmarks** before another transfer. Changed geometry,
owner identity, unrelated pieces or coordinate frames require restarting. A missing pinned source never
silently selects another scan. Cancel aborts preparation or terminates the worker
and rejects late completion. Closing the panel also disposes the dedicated
renderer and its borrowed image lease. Shared rooms, an active placement preview and section/terrain/box clipping are
currently refused. Visibility-only model changes preserve the pairs; changing
source geometry invalidates them. The renderer
`hasActiveClipping()` query reports the actual last-rendered clipping snapshot,
including plugin-supplied clip boxes; store flags alone cannot certify it.

## Transfer, coverage and Apply

After at least four fit and four check pairs, choose destination objects through
selection or the searchable name list. Each chosen object's complete supported
surface is included; the viewer never silently crops, downsamples or narrows it.
Enter the project tolerance and explicitly review landmark spread and residuals.
Both fit and check maximum errors must meet that tolerance before planning.

**Preview transfer** runs the native registered-mesh planner in the existing
appearance worker. The source is one opaque, untinted GLB base-color image.
Distance, normal agreement and ambiguity settings determine which samples are
observed. Unknown samples retain the prior IFC appearance. The coverage report
separates actual transferred interior image texels from centroid-inclusive
sample/area estimates. Padding is excluded from interior texel counts. No Apply
is offered when no interior texel receives scan appearance or chosen objects
have unsupported exclusions.

**Show original / Show transfer** compares the reversible renderer draft.
**Apply scan appearance** commits through ordinary appearance history and asset
ownership; Undo/Redo and textured IFCZIP export use the same existing paths.
Cancel terminates the worker and discards late results. Changing settings,
registration or scope discards the old preview and its temporary image leases.
The exact guarded IFC byte snapshot is shared with the native registration and
transfer jobs, avoiding a second export with a different file-header hash.

The planner retains its work and memory limits. A capacity refusal is actionable
and does not authorize reducing the chosen scope. The public boulder control
uses an explicitly created 350-triangle region from the full 66,122-triangle
source, with real image transfer, unknown retention and fresh IFCZIP import.
This same-source control proves the workflow; it is not evidence of independent
scan-to-BIM accuracy or full-model transfer capacity. Independent scan/model
registration, RGB-point adapters and broader transfer acceptance remain #4381
work.
