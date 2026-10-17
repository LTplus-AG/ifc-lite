// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The antipodal sign rule `detect_obb` collapses face families with, alone in
//! a dependency-free file (no `crate::` paths).
//!
//! `ifc-lite-geometry` keeps its own copy (`math::v3::canonical`) rather than
//! depending on this crate: this one is TS-parity-locked
//! (`packages/clash/src/engine-ts/obb-detect.ts`), so geometry could never
//! change its copy independently. Geometry's tests compile THIS file with
//! `#[path]` (as `world_frame_corpus.rs` is shared, #5406) and assert the two
//! agree bit for bit.

/// Flip `n` so its largest-magnitude component is positive, so a face and its
/// antipodal opposite face collapse to the same canonical axis direction.
/// Ties broken in x, y, z order — identical to the TS `canonical`.
pub(crate) fn canonical(n: [f64; 3]) -> [f64; 3] {
    let (ax, ay, az) = (n[0].abs(), n[1].abs(), n[2].abs());
    let mut idx = 0usize;
    if ay > ax && ay >= az {
        idx = 1;
    } else if az > ax && az > ay {
        idx = 2;
    }
    if n[idx] < 0.0 {
        [-n[0], -n[1], -n[2]]
    } else {
        n
    }
}
