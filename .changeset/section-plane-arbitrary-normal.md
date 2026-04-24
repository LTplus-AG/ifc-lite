---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Section plane now accepts an arbitrary world-space normal in addition to the
three cardinal axes. `SectionPlane` (renderer types + viewer store) gains an
optional `normal: [x, y, z]`; when set the renderer projects the model bounds
onto that normal and uses `position` (0–100%) to interpolate the plane
distance, so the slider keeps offsetting the plane along its own normal. The
WGSL shader already accepted `vec3 normal + f32 distance` — only the JS layer
was hardcoding axes.

Viewer surfaces this as a new "Pick face" tool that arms the next click to set
the section plane through any visible face (the Bonsai-style pick from #243).
The section panel is now draggable, clamped to the 3D canvas area. The
nearest-cardinal `axis` plus a derived `flipped` are still populated for
downstream consumers (BCF snapshots, drawings export, view controls) so they
get an equivalent cardinal cut for free.

The 2D drawing pipeline still requires a cardinal axis: when a custom plane
is active the 2D cap overlay is suppressed and the 2D drawing panel reports
"2D drawing is not available for custom face-picked planes" until the
generator grows arbitrary-normal support.
