# #6232 linear split placement fidelity

The split writer retains the source occurrence's effective placement parent, normalized Axis and orthogonalized RefDirection on the new piece's private placement. It uses the existing canonical `axis3d` reader; no source placement leaf is rewritten for the added piece. An unreadable or parallel section basis refuses atomically before emission.

The Bonsai-authored `apps/viewer/public/samples/hello-wall.ifc` supplies the model context. Real authored asymmetric 0.2 × 0.8 m sections cover a rotated column, a tilted column, a rolled beam and a beam under a rotated intermediate placement, each as a live overlay and as persisted STEP source. Native meshes must preserve the expected added-half bounds, the original union bounds and summed volume. A malformed frame in the second selected target must preserve the complete exported graph, records, journal and allocator.

`element-split-frame.e2e.test.ts` has nine controls. Temporarily restoring the original writer at `b86392328265e166aef1914b86649f74ac283702` makes all nine fail: eight geometric mismatches and one missing refusal. The fixed writer passes these and the four existing split controls, with no skips. Local receipts are `/tmp/6232-split-frame-revert.log` and `/tmp/6232-split-frame-complete.log`.

The local native oracle reused the verified default WASM from final integration source `bfc6d467c3e10387cf1e4dfe9da43066f139cb0e`, including actual main `43e9b79202e01c16ecb990f22496f33864260eb0`. Its SHA-256 is `7d63d9bc94333f10c4044eac3f70bd86bf361b98659ff5e6cb1161def46f597b`. This is not a claim that Rust was rebuilt from the older split branch. Root Turbo builds use the documented missing-wasm-pack soft skip and rebuild the TypeScript dependency graph.
