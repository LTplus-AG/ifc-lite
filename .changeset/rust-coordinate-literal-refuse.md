---
"@ifc-lite/wasm": patch
---

Fix the Rust fast coordinate readers accepting a corrupted STEP numeric literal and splitting it into two coordinates. A dropped comma, `1.52.3`, used to parse as `1.52` and then misread its leftover `.3` as the start of the next coordinate, shifting every later component in the list by one position. `get_cartesian_point_fast`, `get_polyloop_coords_cached`, and the `parse_coordinates_direct`/`parse_coordinates_direct_f64` hot loops (and their comment-aware twins) now require a STEP delimiter right after each parsed number and refuse the point or list otherwise, matching the full tokenizer, which already refused the same input. Rust sibling of the TypeScript-side fix in #5193.
