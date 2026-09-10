# Registered drawing references

A registered reference is a workspace image plane with a string identity. It is
separate from IFC objects and IFC selection. Its immutable record captures the
encoded image digest, original source lineage, four engineering Z-up corners in
metres, the placement frame identity, visibility, lock and opacity. Corner order
matches canonical PDF calibration: top-left, top-right, bottom-right, bottom-left.
Updating or removing an uploaded source never repaints a committed reference.
Explicit replacement swaps image and registration in one reversible command;
Undo retains and restores the previous image and corners together. An optional
frozen `PlaneCalibrationRequest` travels with the record and history, retaining
native landmarks and metric world pose for explicit editing without original PDF
bytes. Persistence validates its fixed-size vectors, invertible raster transform,
positive dimensions/distance and orthogonal nonzero world basis; Rust remains
the source of truth for deriving calibrated corners.

`appearanceReferenceSlice` owns registration actions and independent image leases
for live references and history. Reference commands participate in the existing
workspace Undo/Redo dispatcher alongside model translations and active-model IFC
edits. A new command in any family invalidates redo in the others. Reference
history retains at most 100 commands, and a workspace at most 256 references.
Removing a reference retains its image while Undo needs it; dropping its final
live/history/source owner releases the inventory resource. Explicit unlock is
required before editing or removing a locked reference.

Registration export is bounded versioned JSON using the same metre/Z-up and
`placementFrameKey` convention as model placements. It stores registration only,
not image bytes or original PDFs. Import validates the whole manifest, coordinate
frame and duplicate identities before publication, and refuses to replace locked
references. Missing images remain recoverable registrations. Relinking accepts
only the exact saved image digest and changes no coordinates or source lineage.
It does not silently substitute a newer raster from the same PDF source.

Session reset clears reference records, history and leases. Removing one model or
clearing IFC models for a georeferencing reload preserves independent workspace
references and their ownership; incompatible new frames remain unresolved. A change of coordinate
frame must be handled by the runtime's canonical frame conversion or reported as
unresolved; importing a manifest into a different frame is rejected. The state
foundation does not claim portable project image packaging or IFC annotation
creation. Those use separate, explicit authoring/export operations.

`AppearanceReferenceLibrary` is mounted inside the Appearance workspace when
placing references. Its controls use the real registration actions for separate selection,
visibility, locking, removal, one committed opacity edit, registration file
import/export and exact-image relinking. Invalid files produce inline errors;
imports are canceled on unmount and refuse to overwrite registrations changed
while the file was being read. Editing a registered reference restores its frozen image and calibration into
the shared editor; replacing a catalog source does not edit placed references.
History restores the exact saved engineering frame, even when that frame is currently unresolved. Rendering remains guarded by frame compatibility; Undo never silently converts coordinates or blocks access to older commands. Value-equivalent imports and updates preserve all workspace redo branches.

Normal desktop Select and touch tap share a reference-aware route. An unlocked
visible reference nearer than IFC geometry selects its string identity without
entering the IFC selection callback. IFC/background selection clears reference
selection. Pending picks are discarded after camera, model, frame, geometry,
visibility, tool or newer pointer input changes. Touch-generated compatibility
clicks do not select a second time. The renderer remains responsible for depth
and visibility filtering using the ordinary pick options.

## Original PDF ownership

New PDF registrations also retain the original document SHA-256 and an immutable
page/raster recipe: page number, CropBox/view box, UserUnit, intrinsic and requested
rotation, crop, pixel dimensions, DPI and PDF-to-raster transforms. The recipe must
match the frozen calibration. Editing and replacement carry this provenance with
the image; changing the catalog page cannot change a committed reference.

The existing PDF provider is independently retained by live references, Undo/Redo
history and registered-image editing snapshots. Removing its catalog entry does
not close the original document while one of those owners still needs it. The
last owner releases its bytes and worker. Vector decoding uses that same provider,
original bytes and password, with cancellation and exact document/page/calibration
response checks; it does not reopen a different mutable source slot.

Registration JSON carries this optional provenance, but still excludes PDF bytes
and passwords. Restoring metadata never substitutes another PDF with the same
raster image: only re-uploading the exact document digest can restore its original
provider. Older image-only registrations remain images and are never automatically
promoted to PDF-backed records. This source ownership is used by the explicit PDF vectors option in Save into
model. Its native preview and creation guards are described in the
[PDF annotation workflow](pdf-vector-annotations.md#registered-pdf-annotation-workflow).

[Browser and lifetime evidence](evidence/pdf-reference-lineage/README.md) covers
catalog page changes, removal, retained original decoding, editing, history and
registration export.
