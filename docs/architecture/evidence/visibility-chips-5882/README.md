# Visibility reasons in the viewport (#5882)

These unmodified Playwright screenshots show the viewer after loading the
authored SketchUp IFC files `building-architecture.ifc` and
`building-architecture-rev-b.ifc`. The test hides the second model, activates
Exploded view, and turns off the `IfcSite` type. The three chips appear in the
registry order and show counts without model or file names.

- [Light mode](./light.png)
- [Dark mode](./dark.png)

Captured from the production build of PR #6131 at `8a571b4d` with
`PLAYWRIGHT_PORT=4402 pnpm exec playwright test --project=viewer-e2e
tests/e2e/visibility-chips.e2e.spec.ts --reporter=html` (2/2 passed). The
federation warning in the screenshots reports that the second sample's
declared coordinate frame could not be aligned to the first; the viewer still
loads both models in their local frames. The warning is unrelated to the
visibility chips.
