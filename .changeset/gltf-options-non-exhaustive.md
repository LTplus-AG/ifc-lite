---
'@ifc-lite/wasm': major
---

BREAKING for the Rust crate `ifc-lite-export`: `GltfOptions` gains
`tessellation_quality: TessellationQuality` and becomes `#[non_exhaustive]`.

`GltfOptions` was an exhaustive struct with public fields, so adding a field
already breaks every downstream struct literal. That is a major however it
ships. Taking the break once and pairing it with `#[non_exhaustive]` makes it
the last of its kind: every field added after this one is a minor. Build with
`GltfOptions::default()` and the new `with_*` methods, which is the shape
`ModelOptions` already uses, because `non_exhaustive` forbids every struct
expression from outside the crate and `..Default::default()` is one of them.
The fields stay public, so reading one or assigning to one still compiles.

No JavaScript surface changes. `exportGlb` keeps its signature and its output
is byte-identical, since the viewer's export states `Medium` explicitly. The
major rides this package because the Cargo workspace version follows the
highest npm version after `changeset version`, and that is what publishes the
crates.
