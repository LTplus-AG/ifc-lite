---
'@ifc-lite/geometry': patch
---

Harden three Rust fixtures that could not observe the property they asserted.

Test-only; no production code changed. Each of the three was verified by
mutating production, confirming the old fixture still passed, and confirming
the new one fails.

- `rust/processing/src/simplify_session_tests.rs` — the only `y_up: true` test
  passed `origin: [0.0; 3]`, and `yup_to_zup` of zero is zero, so
  `simplify_element`'s `yup_to_zup(rec.origin)` branch was unobservable:
  replacing it with `let origin = rec.origin;` kept the crate green. The
  record now carries a Z-up origin of (1, 2, 3), fed in as the boundary's Y-up
  swap, and both the local and render extents are pinned at min and max.

- `rust/ffi/src/tests.rs` — `normalize_to_site_local`'s guard skips the shift
  only when all three site-translation components are inside
  `LARGE_COORD_THRESHOLD`, but the only fixture exercising it put all three
  past 1 km, so rewriting `&&` as `||` still shifted. The fixture now uses a
  realistic georeferenced placement (large easting and northing, a 2 m
  elevation), and a second test brackets the constant itself, which the
  previous 1.0-vs-123456.0 pair left free anywhere in between.

- `rust/geometry/src/router/voids/bool2d_path_tests.rs` — `hm_inv()` returned
  the identity and was the argument to every `opening_solid_footprint` call in
  the crate, so production's `let to_host = hm_inv * op.m;` was
  indistinguishable from `let to_host = op.m;`. The host is now placed at
  (3, -2, 5) rotated about Z, `hm_inv()` is its real inverse, and opening
  placements are given in world space as `host_m() * (host-local placement)`.

Scope: these three fixtures only. The sweep that found them did not cover most
of `rust/export`, about 40 files under `rust/processing/tests/`, or the 90-plus
files under `rust/geometry/tests/`; nothing is claimed about those.
