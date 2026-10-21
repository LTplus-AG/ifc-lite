# Comparison filtering browser evidence (#8017)

The production viewer compared the committed `building-architecture.ifc`
(SketchUp export) and its derived `building-architecture-rev-b.ifc` demo revision.
The native comparison reported 1 added, 1 deleted, 2 modified and 19 unchanged.
No result, entity, geometry, visibility or camera output was mocked.

At a 1280 × 800 viewport, the browser regression clicked Added, Deleted and
Changed. Each category hid every other comparison entry, kept its own rows
reachable, and completed the real camera framing operation. Data/properties
filtering selected Changed; Show all results restored the original hidden set.
The shared-preview inspection additionally opened the modified wall's
`Pset_WallCommon.LoadBearing` evidence (`false` → `true`) and scrolled it into view.

- [Added duct](added.png)
- [Deleted kitchen object](deleted.png)
- [Two changed walls](changed.png)
- [Scrollable comparison panel](panel.png)

The three geometry images are unmodified production GPU color-attachment
readbacks, captured after camera completion. The blue is the viewer's selection
highlight. The regression asserts a non-background color population in each
readback. The panel screenshot is an unmodified browser capture; this headless
runtime omits the WebGPU canvas from compositor screenshots, so the separate GPU
readbacks establish what the renderer actually drew.

## Reproduce

Build the viewer from the repository root, serve its production preview, then run:

```sh
PLAYWRIGHT_PORT=5187 pnpm exec playwright test --project=viewer-e2e-ci \
  tests/e2e/compare-impact-6921.e2e.spec.ts --grep 'short panel'
```

Application source was built at `6620777533`; subsequent changes are test
harness, documentation and evidence only. Local validation used Chrome for
Testing 156.0.8078.47, the CI project's SwiftShader/Vulkan flags, and this test's
ANGLE Vulkan override. The override keeps presentation and WebGPU on the same
backend: mixed GL/Vulkan presentation failed before comparison ran on this host.
The local config changed only the Chrome executable location. The final browser
run passed, including all three GPU readbacks.
