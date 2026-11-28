# Split-wall recesses

For #11321, the wall and recess share their authored rectangular axes. The active flush sweep checks 70 combinations of wall angle, finish length and opening direction. Each mesh must have zero signed unmatched edges at stored coordinates and at 1 mm, and its volume must be within 0.6 L of the authored solid.

For #11423, `tilted::each_host_preserves_merge_base` runs the production geometry router in fresh processes on its default route and with all three rectangular shortcuts disabled. It exercises the 90 wall/cutter combinations, 24 straight-wall cases and 10 multiple-opening cases. It compares each host's absolute volume error and four edge counts to that same host and route at merge base `aacea2ea9113605e2af7472f1c1dc6512ad8b5d3`. Signed error is in litres. The counts in order are exact unmatched, exact overused, 1 mm unmatched and 1 mm overused. The optional second group of columns records where the manifold gate changes the result. The topology gate yielded the same measurements as its corresponding build without that gate.

Run the active suite with:

```sh
cargo test -p ifc-lite-geometry --test split_wall_recess
cargo test -p ifc-lite-geometry --features csg_manifold_gate --test split_wall_recess
```

## Independently tilted cutters (#11604)

The separately runnable reproducer asserts authored volume and closure on each independently tilted input. It uses 1.1 L for the wall/cutter and straight-wall fixtures and 0.2 L for the multiple-opening fixture. At a wall angle of 0.5° and a cutter turn of −0.2° from the interface, the default mesh is closed and retains the base volume error of −3.611341 L. That example fails the desired volume assertion. The active suite also reports a regression if that individual mesh reopens.

```sh
cargo test -p ifc-lite-geometry --test split_wall_recess -- --ignored --exact tilted::independently_tilted_authored_cut_11604 --nocapture
```

This command is expected to fail while #11604 is open. It prints each failing fixture, signed volume error, and unmatched count on both grids for each route.
