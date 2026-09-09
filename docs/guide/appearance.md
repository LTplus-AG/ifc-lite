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

## Export and sharing

Use the normal IFC export. A model with retained images exports as **IFC + images**
(IFCZIP). This portable archive contains the baked images, not the original PDF
or an editable drawing recipe. Reopening the archive keeps IFC object identity,
selection and appearance.

A finished model can be shared for viewing. Appearance editing is unavailable
inside an active shared room; leave the room to edit and share the finished
result. IFCX export from a shared model preserves textured fragments through the
versioned appearance extension described in the [export guide](exporting.md).

PDF projection changes surface appearance. It does not create a reference plane,
extract vector annotations, recognize text, or create building geometry. Those
are separate operations in the implementation roadmap.

### Saving a registered reference into IFC

The viewer command `createAnnotationFromReference` creates a textured
`IfcAnnotation` from a registered image or PDF-page raster. It takes the target
model and spatial container, preserves the original encoded image, and plans IFC
rows and geometry through the native annotation planner. The new owner participates
in the model's existing undo/redo history and portable IFC texture export.
Storey, building and space targets retain their actual spatial containment through
creation, Undo, Redo and export; a space or building is never treated as a storey.

The registration remains a separate workspace reference. Its raster is captured
by digest; later source edits cannot silently repaint the IFC annotation. Saving
requires IFC4 or IFC4X3, a rectangular calibrated plane, and a stable coordinate
frame. Finish any active model reposition operation first. Realigned federated
models currently require choosing the workspace anchor model until inverse
federation registration is available; the command reports this explicitly.
