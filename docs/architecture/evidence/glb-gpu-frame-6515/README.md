# GLB upload frame invariant (#6515)

The error events identify non-streaming GPU upload after GLB imports. Telemetry does not record the source filename or geometry, so this evidence reproduces the numerical defect class, not the reporter's original file.

The diagnostic GLB in `tests/e2e/model-reposition.e2e.spec.ts` has two valid Float32 triangles: a 1 µm edge near the authored origin and a second triangle 1 km away. All six vertices are indexed. Its node translation is `[155000, 0, 5500000]`.

The base frame resolver at `499b68e82` returns no valid frame: bounding-box recentering rounds the tiny edge away. The branch retains the authored frame. `frame-oracle.json` records that base/branch run. The renderer regression checks actual GPU-buffer upload bytes, both triangles, and depth coincidence of the derived visibility batch, at zero and translated origins. Existing invalid-coordinate and failed-upload rollback tests remain green.

Root Turbo renderer tests: 1,957 passed, two existing skips, no failures. Full root typecheck: all 3,137 test files covered.

Real Chrome/SwiftShader browser acceptance passed through the ordinary file-open control and canonical GLB loader. The resident scene retains both triangles and the 1 µm edge; clicking the distant triangle selects owner 19. `rendered.png` is a production renderer color-buffer readback after that click. It proves the distant triangle renders; the tiny triangle is intentionally subpixel at this camera scale. A compositor screenshot can be blank under SwiftShader, so it is not used as the color witness.

Re-run the browser test with the standard `viewer-e2e-ci` project and `--grep '#6515'`. The recorded run used this checkout's isolated Vite server at port 6651; final-head CI also covers the renderer and browser regression.
