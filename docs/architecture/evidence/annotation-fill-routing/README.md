# Meshed annotation fill routing — #4459

The PDF authoring control contains one `IfcAnnotation` owner (#92), with two
direct fill representation items (#77 and #86). Ordinary import previously
displayed the canonical vertical geometry and an additional symbolic copy
lifted onto the storey plane. The copy disappeared when symbolic annotations
were hidden, identifying the second rendering route.

The fix retains the symbolic drawing primitives and removes only an exact,
qualified owner/item match from the 3D overlay output. Unknown provenance,
mapped occurrences and multiple representations remain conservative. The
canonical federation mapping resolves both owner and item identities.

## Browser evidence

`reopened-colours.png` and `reopened-selected.png` show ordinary IFCZIP import
of the original registered PDF control exported by the PDF authoring UI.
No annotation visibility toggle is used to obtain the result. The actual
symbolic GPU fill pipeline reports no geometry; the 2D parse cache retains
both fill records, and both native mesh pieces contain two triangles.
A normal pointer click selects the annotation. `browser-proof.json` records
the observed owner/item identities and selection coordinates.

The import retains a shared empty overlay array, so it need not call the upload
method again. The proof checks the live GPU pipeline's `hasGeometry()` result;
an empty upload log alone would not prove absence of a duplicate.

Run `browser-proof.mjs` against a local viewer with `PROOF_URL`,
`PROOF_IFCZIP` (the authored control), and `PROOF_BOOTSTRAP_IFCZIP`
(the original base model). `PROOF_OWNER` defaults to 92. The base model
initializes the renderer before instrumentation; the authored control then
loads through the ordinary Open input. Source controls and their PDF oracle
are documented in the PDF authoring UI evidence.

## Regression boundaries

The mounted store/loader regression uses the actual federation transform,
which globalizes both mesh identifiers. The memory-release regression invokes
the actual store callback and verifies that released CPU arrays do not erase
the identity of geometry retained on the GPU. This callback is currently
disabled in `ViewportContainer`; it is a supported dormant path, not a claim
that today's ordinary viewer load releases those arrays.

Weak provenance retains no mesh arrays. Unknown empty geometry cannot suppress
a drawing; changing a recorded owner or item invalidates the certificate.
The native planner control independently checks that retained 2D fill items
match the ordinary canonical geometry output.

These controls cover duplicate routing. They do not certify arbitrary PDF
features or replace the separate PDF authoring and independent-reader checks.
