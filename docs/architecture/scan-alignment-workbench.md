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
loaded source model and IFC are unchanged. This stage does not bake textures,
reconstruct geometry, or save a transferable recipe yet. Its draft belongs to
the mounted alignment panel; switching to another Appearance action discards
these landmark pairs.

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
committed workspace model placement is included. A later transfer adapter must
supply the validated native IFC-world-to-this-frame transform; it must not infer
identity from the axis name. Source and target frame identities, effective IFC
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

Changing a source, target, placement or effective IFC invalidates the draft;
restart explicitly against the current models. A missing pinned source never
silently selects another scan. Cancel aborts preparation or terminates the worker
and rejects late completion. Closing the panel also disposes the dedicated
renderer and its borrowed image lease. Shared rooms and an active placement
preview are currently refused.
