---
"@ifc-lite/renderer": patch
---

Fix the model disappearing when a non-Default lighting preset (Day / Overcast / Evening / Night) is selected in the Sun & Sky panel. Two independent bugs on the procedural-sky path, both surfaced only on strict WebGPU implementations (Chromium/Edge on real hardware); permissive drivers such as SwiftShader hid them.

- **Sky shader compile error (primary).** `sky.wgsl` called `smoothstep(0.0, -0.1, elevation)` with the edges reversed. WGSL requires `low < high`, so Tint rejected the whole shader module ("low 0.0 not less than high -0.1"); the sky pipeline was then invalid and encoding the frame failed, blanking the model. Rewritten as `1.0 - smoothstep(-0.1, 0.0, elevation)` (identical result, valid edges).

- **Lighting environment bind-group invalidation (latent).** The global lighting environment was bound at `group(1)` before the sky pass, but the sky pipeline's layout is incompatible (its own `group(0)`, no `group(1)`), so drawing the sky invalidates that binding — and the flat batch loop only re-binds `group(0)` per batch. The environment is now (re)bound at `group(1)` after the sky pass and before the first geometry draw, matching what the instanced passes already did. This was masked by the shader bug (the sky never validly drew); it becomes reachable now that the sky compiles.
