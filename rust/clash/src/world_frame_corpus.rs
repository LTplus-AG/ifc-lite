// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! World-frame corpus core, shared by `ifc-lite-clash` and
//! `ifc-lite-geometry` tests (#5406).
//!
//! This is the dependency-free half of the Rust world-frame corpus: the
//! placements and the f32 ULP they are measured against. It lives in
//! `rust/clash` because that crate has an empty `[dependencies]` and sits at
//! the bottom of the graph; `rust/geometry/src/world_frame_fixture.rs`
//! compiles this same file with `#[path]` and adds the `Mesh`-typed builders
//! on top. One source, so the two crates cannot drift on what "far from the
//! origin" means.
//!
//! Chosen over the two alternatives on purpose:
//! - PROMOTING the geometry module (`pub` + a dependency) is impossible
//!   without an edge `rust/clash -> rust/geometry`, and `rust/geometry`
//!   already dev-depends on `rust/clash`;
//! - a dedicated fixture CRATE would be a new workspace member for ~40 lines,
//!   and every workspace member is picked up by the release, version-sync
//!   and crates.io tooling;
//! - DUPLICATING would recreate exactly the drift this corpus exists to stop.
//!
//! Test-only on both sides (`#[cfg(test)]`), so it never reaches a shipping
//! build and `cargo publish` of either crate is unaffected. Keep it free of
//! `crate::` paths: it is compiled into two crates.
//!
//! The TS half is `packages/world-frame-fixtures` (same offset, same cases,
//! plus the RTC-origin cases that only exist on the TS `MeshData` surface).

/// Far-from-origin offset magnitude (metres). 10 km: the f32 ULP there is
/// ~0.98 mm and `extent * 2^-22` reads ~2.4 mm — the regime of every
/// reproduced defect in the class.
pub(crate) const WORLD_FRAME_OFFSET_M: f64 = 10_000.0;

/// Corpus placement. The far case offsets along X ONLY, so tests of
/// Z-behaviour (a Z plane normal, a Z clearance) catch max-over-axes
/// tolerance overreach instead of coincidentally agreeing with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorldFrameCase {
    /// Counter-case: near the origin. A "fix" that simply widens or
    /// tightens every tolerance fails here.
    AtOrigin,
    /// `WORLD_FRAME_OFFSET_M` out along X, baked through f32.
    FarBaked,
}

pub(crate) const WORLD_FRAME_CASES: [WorldFrameCase; 2] =
    [WorldFrameCase::AtOrigin, WorldFrameCase::FarBaked];

impl WorldFrameCase {
    pub(crate) fn offset(self) -> [f64; 3] {
        match self {
            WorldFrameCase::AtOrigin => [0.0, 0.0, 0.0],
            WorldFrameCase::FarBaked => [WORLD_FRAME_OFFSET_M, 0.0, 0.0],
        }
    }
}

/// Unit of least precision of an f32 at the given magnitude (exact, via the
/// bit pattern).
pub(crate) fn ulp32(magnitude: f64) -> f64 {
    let f = (magnitude.abs()) as f32;
    if f == 0.0 {
        return f64::from(f32::from_bits(1));
    }
    f64::from(f32::from_bits(f.to_bits() + 1)) - f64::from(f)
}
