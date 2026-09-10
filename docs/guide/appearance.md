# Images and PDF pages on IFC objects

Open **Author → Appearance** to use an image or a PDF page across surfaces in a
loaded IFC4 or IFC4X3 model. The panel is also available from the activity rail
and command palette.

Choose the target model, then choose the whole model, selected objects, an IFC
class, or an exact type. Types with the same name remain separate. If some
objects are unsupported, the panel explains the exclusions and offers an
explicit supported-objects selection.

## Image appearance

Upload a PNG or JPEG, or reuse a source already in the panel. Use **Existing UV
coordinates** to retain an existing layout, or choose **Planar projection** or
**Box projection** with physical tile sizes in metres. Rotation, offsets and
repeat controls update the preview across the chosen scope.

**Compare original** temporarily restores the committed appearance. **Discard**
removes the draft. **Apply** saves one IFC edit with the normal Undo/Redo history.
During preparation, Discard cancels before publication; closing the panel also
cancels pending work. Broad changes can still pause briefly during final
validation and publication.

## PDF page projection

1. Upload a PDF in the same source picker. Enter its password if prompted.
2. Choose the page and rotation. Drag a crop on the full-page preview, or enter
   its paper margins. Image quality changes raster resolution, not drawing scale.
3. Under **Drawing scale**, choose two known points A and B on the cropped image
   and enter their measured building distance in metres. Keyboard users can
   focus the image, move the cursor with arrow keys, and press Enter to place
   each point.
4. Choose a horizontal or vertical projection plane. Under alignment, enter the
   model coordinates of point A and the rotation of the A–B direction. These
   coordinates use the IFC model's Z-up axes.
5. Review the shared projection across the selected objects, compare the
   original, and Apply.

The page has finite bounds. It does not repeat or stretch separately to each
object. The bake combines the page with the existing surface colour or texture
outside its bounds; transparent page pixels reveal the previous appearance.
Existing textures are resampled into the baked output. The compositor retains
at least their sampling density and refuses a bake that cannot fit its image
budget, rather than silently lowering that density. Reduce the selected scope
when a high-resolution surface exceeds the budget.

Landmarks stay in native page coordinates when crop, rotation or quality changes.
Selecting a different page clears its calibration. A PDF source keeps its
original document during the session; replacing its page releases unused raster
images while committed results and Undo/Redo retain the images they need.

## Several scopes and models together

Use **Add this scope** to capture the current model, image or PDF page, object
scope and mapping. Add further assignments with different sources or settings.
The list shows each saved scope; reorder rows to choose which wins on overlapping
objects. **Review objects and exceptions** lets you search by name or IFC GlobalId
and exclude individual members. An exclusion leaves any earlier assignment in
place for that object.

Choose **Preview all assignments**, compare the originals, then **Apply**. The
whole operation is saved together. One Undo from any participating model restores
all targets; Redo reapplies them. If another model has a newer edit, undo that
edit first before undoing the grouped appearance change. Identical model filenames
show a Model 1 / Model 2 cue in target and export selectors.

**Save recipe** retains the logical scopes and mappings. After **Restore recipe**,
choose the loaded models and original sources, review membership changes, and
accept the new scope before previewing. Source choices for several rows in one
model can be staged together. The recipe does not include source images or PDF
files; load those separately. Unchanged scopes can resume without repeated
confirmation while their original models and sources remain loaded.

## Export and sharing

Use the normal IFC export. A model with retained images exports as **IFC + images**
(IFCZIP). This portable archive contains the baked images, not the original PDF
or an editable drawing recipe. Reopening the archive keeps IFC object identity,
selection and appearance.

A finished model can be shared for viewing. Appearance editing is unavailable
inside an active shared room; leave the room to edit and share the finished
result. IFCX export from a shared model preserves textured fragments through the
versioned appearance extension described in the [export guide](exporting.md).

PDF projection changes surface appearance. Vector extraction, text recognition,
and scan-derived building geometry remain separate operations in the implementation roadmap.

## Drawing references in 2D and 3D

Choose **Place as reference** in the same Appearance panel to place an image or
PDF-page raster independently of IFC surfaces. Calibrate two image points and
enter their measured distance, then choose the projection plane and point A’s
IFC world coordinates. **Place reference** adds the drawing to the workspace and
its Undo/Redo history; an IFC target is not required.

Registered drawings stay visible when the panel closes. Select an unlocked
drawing in the viewport or its library row. The library provides visibility,
lock, opacity, and removal controls. A changed source does not repaint an already
placed drawing. Coordinate-frame mismatches leave the registration unavailable
until it is registered for that frame; renderer origin rebasing preserves its
engineering position.

The existing 2D drawing canvas also shows visible registered rasters beneath
the cut geometry. Plan, elevation, mirrored, custom-plane and sheet views project
the same four engineering corners as 3D; they do not resize the image to its
screen-aligned bounding box. An edge-on reference has no visible projected area.
Hide, opacity, frame checks and relinking the original image apply to both views.
These workspace underlays do not become vector drawing entities; use
**Save into model** for a portable textured IFC annotation.

**Export drawing registration** saves positions, image digests, and calibration
recipes as JSON. Keep the original raster images alongside it: registration JSON
does not embed images. **Import drawing registration** restores the records;
**Relink original image** verifies the exact image digest for any missing raster.
Independent references are currently local to the workspace, not room content.

### Editing a drawing registration

Choose **Edit** beside an unlocked registered drawing. The same source and scale
controls restore its exact raster and measured landmarks, even when the original
PDF has been removed or moved to another page. The restored image is a reusable
source; it does not reopen or change the PDF document.

Adjust the measured span or placement and choose **Save registration**. This
replaces the drawing in one Undo step, retaining its visibility and opacity.
**Discard** leaves the committed drawing unchanged. Choosing another source while
editing is an explicit image replacement; subsequent source edits never repaint
saved drawings. Concurrent changes to the drawing prevent a stale Save.

Relink a missing original image before editing. Imported registrations without a
calibration recipe, or with a custom plane that the planar controls cannot
represent, retain their existing placement and report why editing is unavailable.

### Saving a registered reference into IFC

Expand **Save into model** on a registered drawing. Choose an editable model,
its spatial container, and the annotation’s **Name**, then choose **Create annotation**.
The new textured `IfcAnnotation` is selected in the viewer. **Cancel creation**
cancels preparation before publication. Use normal Undo/Redo and IFC + images
export for the created object.

The viewer command `createAnnotationFromReference` preserves the original encoded
image and plans IFC rows and geometry through the native annotation planner.
Storey, building and space targets retain their actual spatial containment through
creation, Undo, Redo and export; a space or building is never treated as a storey.

The registration remains a separate workspace reference. Its raster is captured
by digest; later source edits cannot silently repaint the IFC annotation. Saving
requires IFC4 or IFC4X3, a rectangular calibrated plane, and a stable coordinate
frame. Finish any active model reposition operation first. Realigned federated
models currently require choosing the workspace anchor model until inverse
federation registration is available; the command reports this explicitly.

## Create an IFC object from a scan surface

Open or add a textured GLB, then open **Author → Appearance → Create from scan**.
Choose its surface in **Source surface**. The preview uses the original image;
drag to orbit and scroll to zoom without moving the main view.

Use **Select region** and drag a rectangle to keep part of the surface. The
rectangle selects whole triangles by their projected centres, through both the
front and back of the surface. It does not cut new edges at the rectangle border.
The preview shows exactly the retained textured region and its triangle count.
**Entire surface** restores the complete source surface.

Choose an editable IFC4 destination model, spatial container, and Name, then
click **Create IFC object**. The resulting `IfcBuildingElementProxy` is selected
and participates in Undo/Redo. The original scan remains available. Completed
workspace repositioning is respected; finish an active repositioning operation
before creating the region. Semantic classification remains future work.

Export **IFC + images** to keep the original encoded image with the authored
geometry. Source UV seams and sampler repeat flags are preserved. Each capture
is limited to 200,000 triangles and 200,000 position/UV rows. The source surface
preview is also limited to 200,000 triangles. UVs must lie within `[0,1]`; tinted
or translucent material factors must first be baked into the source image.
Creation is available outside shared rooms; the saved IFC can then be shared.

For implementation status, shared workflow boundaries and future scan/PDF options,
see the [appearance roadmap](../architecture/appearance-roadmap.md).

## Appearance on evaluated occurrences

Select an image or PDF page, choose the IFC scope, and enable **Convert supported
objects to mesh** when the chosen objects use mapped type geometry or supported
swept geometry with openings. The option is
off by default and requires planar or box mapping. The preview lists the objects
whose current shape will become mesh geometry instead of using their type's
parametric geometry. **Compare original** temporarily restores the original;
**Discard** publishes no IFC changes. **Apply** saves the texture and conversion
in one operation, and Undo restores both together.

Conversion preserves each product's identity, placement, properties and semantic
relationships. Shared type geometry and sibling occurrences stay unchanged.
Supported metre-unit opening hosts retain their already-cut shape. Their opening
relationships remain, while the opening Body becomes a Reference representation
and stops rendering or cutting again. Preview, Discard and Undo include these
opening objects, even when their type is hidden. Shared type geometry is preserved
by replacing only the occurrence Body; ambiguous ownership, layered slicing and
unsupported materials remain excluded. Use **Use supported objects** to explicitly narrow a
partially supported scope, then inspect the refreshed preview before applying.
Export **IFC + images** to retain portable appearance on reopening or sharing.
GPU-instanced occurrences use the same workflow: preview replaces only the chosen
occurrence, and Undo restores its original shared instance. Finish any model
placement preview and return to stacked levels before preparing a conversion.
Models requiring CRS reprojection are excluded from this initial conversion path.

Some readers, including IfcOpenShell 0.8.2 with its default subtraction setting,
incorrectly subtract Reference openings again; see the
[independent interoperability evidence](../architecture/evidence/evaluated-openings/README.md).

Native `planAppearance` and `planPageAppearance` requests accept
`representationPolicy: "evaluatedOccurrence"`; the omitted policy is `"preserve"`.
Returned `conversions` identify the original item and corner provenance and the
replacement item. Renderer integrations pass validated global original/replacement
IDs in `AppearancePreview.begin(owner, { geometryItemRemaps })`; each pair has
`from` and `to` fields. The renderer freezes these explicit pairs, retains exact
triangle-corner and ownership checks, and records the pairs in `AppearanceChange`
for reversible history. Unlisted item-ID changes remain invalid. Opening conversions
also carry bounded `sourceRemovedMeshes` in canonical native `MeshData` form.
After validating product/item identity and placement, renderer integrations pass
`companionOriginals` to `AppearancePreview.begin`; the only permitted transitions
are those exact untextured originals and an empty mesh list. `sameCompanionParts`
compares that restoration contract. `companionHidden: true` additionally requires
the host to prove current hidden visibility and exact canonical source inventory;
it preserves nonresident originals without uploading or exposing them during
preparation. Retain the source resources through command history and release them
when that history is disposed. See the
[evaluated-occurrence contract](../architecture/appearance-evaluated-occurrences.md).

Renderer integrations preparing an occurrence replacement can call
`scene.retainInstancedOccurrence(globalId, modelIndex)` after geometry is resident.
The returned lease has `valid`, `setSuppressed(boolean)`, and `release()` members.
Suppression removes that occurrence from drawing, picking, and CPU instance
geometry enumeration while retaining its shared template, current placement,
selection, and colour override state. Releasing it restores the current user
hide/isolate state. Model removal or a scene reset invalidates the lease.
Retained leases prevent CPU geometry release until history releases them.

This resource operation does not create IFC geometry or canonical UV provenance.
An appearance integration must separately validate the native evaluated mesh and
its model frame, publish a replacement, and retain the lease for Undo. It must
release the lease if preparation fails or the preview is discarded.

Opted-in native occurrence plans include canonical `sourcePositions`,
`sourceNormals`, `sourceOrigin`, `sourceColor`, and `rtcOffset` alongside
`sourceIndices` in each `conversions` entry. Renderer integrations use that bounded
IFC Z-up snapshot to prepare one occurrence; reconstructing a GPU instance does
not supply equivalent source provenance. See the
[evaluated occurrence contract](../architecture/appearance-evaluated-occurrences.md)
for units, frame restoration, and eligibility limits.

The viewer passes that canonical source in renderer Y-up coordinates through
`scene.placeAppearanceSource(mesh)` and then
`AppearancePreview.begin(owner, { materializedOriginals, geometryItemRemaps })`.
`getParts(owner)` includes retained canonical originals when the GPU instance is
visible. Before committing, each history command calls `retainSource(owner)` and
keeps the returned release function until that command is disposed. Multiple
commands share one original occurrence; disposing an older command cannot restore
it beneath a newer edit. `scene.appearanceSourceMesh(mesh)` recovers model-local
geometry for publication without applying the registered model translation twice.
These methods are optional on custom renderer adapters; the viewer refuses
instance conversion if its frame conversion API is unavailable.

For a flat-geometry rebuild, `scene.clearFlatGeometryForRebuild(visibleGeometry,
loadedModelIndices, sourceGeometry)` validates every retained owner against the
full loaded source geometry before disposing GPU buffers. Pass hidden models in
that source inventory to retain their appearance history across hide/show.
Changed or removed owners lose their old instance lease; ordinary
`clearFlatGeometry()` and full scene reset still invalidate all such leases.

Authored annotation/captured-object `Name` values and appearance image paths
must not consist of a reserved mutation wire token (`$`, `*`, `#123`, or
`.ENUM.`, including surrounding whitespace). Native planners refuse these
values before returning a plan because the current STEP mutation protocol has
no unqualified literal-string marker. Ordinary names, including Unicode and
punctuation, remain unchanged. Preserved page material names use the same rule.

### Scan transfer capacity

Registered mesh transfer keeps the entire selected IFC object as its target.
Preview reports observed and unknown coverage; unreliable observations keep the
object’s previous appearance. Increasing atlas density can improve visible
detail but also increases memory use. If a request exceeds the bounded memory
or work allowance, reduce the chosen density or explicitly narrow the source
extent, then preview again. The viewer never silently removes target triangles.

The complete selected boulder capture is covered by the
[full-target acceptance evidence](../architecture/evidence/mesh-transfer-full-target/README.md),
including export, fresh import, selection and an independent IFC reader. This
known-derived control does not establish automatic alignment of unrelated scans
and BIM models.
