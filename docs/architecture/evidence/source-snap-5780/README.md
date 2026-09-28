# Authored source snapping browser witness (#5780)

The [Snowdon selected-source frame](snowdon-selected-source-frame.png) is a
production WebGPU color readback from the Revit Snowdon Structural IFC after
selecting reinforcing bar #132347 and clicking its authored directrix. It shows
the selected bent source in context. The GPU color frame does not contain the
HTML snap HUD, so the image alone does not prove snapping.

`tests/e2e/swept-disk-source-snap.e2e.spec.ts` is the behavioral witness. With
`REBAR_IFC` set to the Snowdon model and `E2E_GPU_STRICT=1`, it verifies the
source inspector, exact source-curve hover identity, a clicked point less than
1e-7 world units from the authored finite line, drag endpoints on that line,
and clearing when the overlay turns off. The same strict test passed with the
small committed IFC2X3 U-bar used by default in CI; that fixture is not an
authoring-tool ground-truth substitute for the Snowdon run.
