# Lazy authoring destinations: actual browser acceptance

Issue #4412. Open the public boulder GLB first, then add the two-coloured-seam-walls IFC. Do not select an IFC object before opening Appearance. Both `lazy-before.json` records confirm the destination has no mutation view at this point.

Two fresh browser journeys passed:

- **Create from scan:** choose the complete textured boulder surface and the IFC destination; create a textured proxy, Undo, Redo, and export IFCZIP. The new owner replaces the selection and its destination becomes active, making Undo available even though the GLB was opened first.
- **Place as reference:** upload the boulder image, select page calibration landmarks and a two-metre span, place the vertical reference, then Save into model as a textured IfcAnnotation. Create, Undo, Redo, IFCZIP export and normal fresh-tab import pass. The reopened annotation has UVs and a texture reference and is visibly textured in `reference/reopened.png`.

Export uses the existing Model dropdown to explicitly choose the IFC destination (the dialog initially chooses its first loaded model). No exporter behavior is changed. Large fixture/export files are not committed; exact input and runtime hashes are recorded in `runtime.json`. Browser and dev-server processes were closed after acceptance.

Mounted tests additionally check eligibility without a prior view, exclusion of mesh-only stores, canonical view reuse preserving actual IFC Name edits through serialization, and the actual authoring-history route after selecting a destination object. The existing IFC-first workflow is unchanged; the regression is the reverse order documented here.
