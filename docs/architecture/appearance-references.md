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
