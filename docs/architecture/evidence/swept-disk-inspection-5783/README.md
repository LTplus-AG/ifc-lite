# Swept-disk source inspection (#5783)

These images came from one passing strict Chrome run of
`tests/e2e/swept-disk-inspection.e2e.spec.ts` against the Revit Snowdon
Structural IFC, selecting `IfcReinforcingBar` #132347.

- `snowdon-source-inspector-ui.png` shows the viewer's source inspection panel:
  a 9.525 mm radius, a 3.61642 m centreline, and line/arc segment readouts.
  Headless Chrome's page screenshot did not include the WebGPU canvas.
- `snowdon-isolated-rebar-frame.png` is the renderer's color-frame readback
  from the same run after isolating that selected bar. It shows the actual
  rendered bent bar, independent of the page screenshot limitation.

The browser test also asserted that selecting a source segment changed the
renderer pixels and that isolating the bar changed them again.
