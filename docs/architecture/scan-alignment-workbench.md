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
Distance, normal agreement, ambiguity and behind-surface settings determine
which samples are observed. Unknown samples retain the prior IFC appearance.
The behind-surface limit refuses a same-facing scan surface that lies deeper
than that distance behind the IFC face, so the far side of a thin wall, or
furniture beyond it, never paints the near face. Its default equals the default
project tolerance (10 mm), so a registration accepted at that residual is not
refused on one side of the face only; raise it only to the accepted
registration error plus modelling tolerance. The coverage report
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
The [committed browser and independent IFC evidence](evidence/scan-transfer-workspace/README.md) records the original/transfer comparison and normal reimport. [Room portability acceptance](evidence/scan-transfer-room/README.md) also verifies fresh guest/rejoin and room IFCX export/reopen with identical atlas pixels, world/UV association and object picking. This same-source control proves the workflow; it is not evidence of independent
scan-to-BIM accuracy or full-model transfer capacity. Independent scan/model
registration, RGB-point adapters and broader transfer acceptance remain #4381
work.

## What counts as validated

Three kinds of evidence exist, and they answer different questions:

1. **Controlled surface behaviour** (native tests in
   `rust/processing/src/appearance/transfer_acceptance_tests.rs`, mirrored over
   the real WASM boundary by `scripts/lib/wasm-mesh-transfer-surfaces-contract.mjs`,
   summarised in [mesh-transfer-surfaces](evidence/mesh-transfer-surfaces/README.md)).
   A 4 mm two-sided partition observes each side only from its own capture; a
   gap in one capture stays unknown instead of receiving the opposite side; a
   slab in front of an uncaptured region is refused by its wall-facing normal,
   and its same-facing side beyond the wall by the behind-surface limit. These
   are stated invariants over synthetic fixtures with an identity registration.
   They prove the classification rules, not registration accuracy.
2. **Same-source workflow controls** in the browser
   ([workspace](evidence/scan-transfer-workspace/README.md),
   [room portability](evidence/scan-transfer-room/README.md),
   [full selected target](evidence/mesh-transfer-full-target/README.md)) prove
   Preview, Compare, Apply, Undo/Redo, IFCZIP export, fresh import and shared
   rooms with retained unknown pixels. The GLB and IFC derive from one surface,
   so residuals there say nothing about aligning independent captures.
3. **Independent real-pair registration** is the open gate. It requires a
   licensed scan/IFC pair, reviewed fit landmarks and spatially distributed
   held-out check landmarks at several heights, frozen before solving, with the
   held-out residuals published before any bake tolerance is chosen. The
   [CRAS candidate](evidence/scan-transfer/README.md) has real bytes and a
   protocol but no such landmark lists; its scan is an RGB point cloud, which the
   workbench cannot yet use as a transfer source. Until an RGB-point source path
   and that reviewed list exist, no accuracy tolerance is validated and the
   tolerance the user enters remains a project decision, not a measured one.

A one-sided surface facing the same way as the IFC face within the distance
bound (a poster on a wall) is observed as the wall's appearance: local nearest
surface matching cannot separate it from the wall without scanner viewpoints.
The distance bound is the explicit control for such fixtures.
