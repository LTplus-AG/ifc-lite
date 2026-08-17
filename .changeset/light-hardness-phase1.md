---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Phase 1 of the Blender-like lighting work (#2670): expose light-hardness and shadow-feel controls in the standalone WebGPU viewer.

**Renderer** — `LightingEnvironment` gains a `sunSoftness` field: the diffuse-wrap that sets the sun terminator, previously hardcoded to `0.3` in the shader. `0` is a crisp light/shadow boundary (harder shadows), larger values soften it (overcast). Resolved into the existing environment uniform (a spare pad slot, no UBO size change) and clamped to `[0, 1]`; omitting it reproduces the historic look exactly.

**Viewer** — the Sun & Sky panel adds two sliders (WebGPU shading, hidden in world-context mode): **Light hardness** (deepens shadows by cutting hemisphere ambient + fill) and **Terminator softness** (trims the preset's `sunSoftness`). Both are user trims composed onto the active preset — switching presets changes the base, the trims persist — mirroring Exposure. Presets now carry per-preset softness (crisp Day/Evening, soft Overcast) so the terminator changes with the sky being simulated. Settings persist in localStorage.
