---
"@ifc-lite/wasm": patch
---

Fix the Rust fast coordinate readers accepting a corrupted STEP numeric literal. A dropped comma, `1.52.3`, used to parse as `1.52` and then misread the leftover `.3` as the next coordinate, shifting every later component by one position. `nan`/`inf` were read as coordinates, and a corrupt last value became `z = 0`. Every fast reader (`get_cartesian_point_fast`, `get_polyloop_coords_cached`, `parse_coordinates_direct`/`_f64` and their comment-aware twins) now reads each number through one shared STEP numeric-literal grammar. On a corrupt literal the whole point or list is dropped, the same as the full tokenizer does with the record. A comment after a value is still accepted. Rust sibling of #5193.
