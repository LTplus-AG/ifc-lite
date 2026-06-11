// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cross-platform determinism floor for the pure-Rust CSG kernel.
//!
//! The deleted legacy server (BSP) and viewer (Manifold C++) kernels diverged, and
//! Manifold itself was non-deterministic across platforms — Linux x86_64
//! collapsed some coincident-/near-coplanar-face boolean clips where macOS
//! aarch64 produced the correct result. The pure-Rust kernel (now the only one) dissolves that by routing every in/out and on-plane decision
//! through Shewchuk *exact* predicates, whose SIGN is mathematically
//! determined and therefore identical on every IEEE-754 radix-2 target.
//!
//! This test pins that invariant. It evaluates `robust::orient3d` over a set of
//! adversarial configurations (exactly-coplanar, building-scale ±1 nm off-plane,
//! the near-coincident large-coordinate class Manifold collapses on, etc.) and
//! packs each result's sign into a fingerprint. The fingerprint is a platform
//! invariant — verified locally identical on aarch64 native, wasm32, AND (via
//! CI on `ubuntu-latest` / depot-ubuntu = **x86_64**, the exact platform where
//! Manifold's float CSG diverges) here. A divergence here means the exact-
//! predicate foundation does not hold on this target and the pure-Rust topology-
//! determinism guarantee is void — so this test must stay green on every CI arch.

use robust::{orient3d, Coord3D};

type V3 = [f64; 3];
#[inline]
fn c(v: V3) -> Coord3D<f64> {
    Coord3D { x: v[0], y: v[1], z: v[2] }
}

/// (a, b, c) define a plane; d is the point classified against it.
fn configs() -> [[V3; 4]; 8] {
    [
        // 1. Exactly coplanar unit quad -> orient3d == 0.
        [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [1., 1., 0.]],
        // 2. Building-scale plane, point 1 nanometre ABOVE.
        [[0., 0., 12.3456789], [10., 0., 12.3456789], [0., 7., 12.3456789], [3.3, 2.1, 12.3456789 + 1e-9]],
        // 3. Same plane, 1 nanometre BELOW -> opposite sign of #2.
        [[0., 0., 12.3456789], [10., 0., 12.3456789], [0., 7., 12.3456789], [3.3, 2.1, 12.3456789 - 1e-9]],
        // 4. Near-coincident faces at large coords (the Manifold x86_64 collapse class).
        [[1.0e7, 1.0e7, 0.], [1.0e7 + 1., 1.0e7, 0.], [1.0e7, 1.0e7 + 1., 0.], [1.0e7 + 0.5, 1.0e7 + 0.5, 1e-7]],
        // 5. Skewed (non-axis) plane with a point just off it.
        [[0., 0., 0.], [1., 2., 3.], [-2., 1., 0.5], [0.5, 0.5, 0.5]],
        // 6. Collinear base (degenerate) -> coplanar with anything -> 0.
        [[0., 0., 0.], [1., 1., 1.], [2., 2., 2.], [5., 1., 9.]],
        // 7. Sub-millimetre tetra -> definite positive volume must survive.
        [[0., 0., 0.], [1e-4, 0., 0.], [0., 1e-4, 0.], [0., 0., 1e-4]],
        // 8. Same tetra mirrored -> opposite sign of #7.
        [[0., 0., 0.], [0., 1e-4, 0.], [1e-4, 0., 0.], [0., 0., 1e-4]],
    ]
}

/// 0 = on-plane, 1 = positive side, 2 = negative side.
fn sign_code(cfg: &[V3; 4]) -> u64 {
    let s = orient3d(c(cfg[0]), c(cfg[1]), c(cfg[2]), c(cfg[3]));
    if s > 0.0 {
        1
    } else if s < 0.0 {
        2
    } else {
        0
    }
}

/// Pack the 8 sign codes (4 bits each) into a single platform-invariant value.
fn fingerprint() -> u64 {
    configs()
        .iter()
        .enumerate()
        .fold(0u64, |bits, (i, cfg)| bits | (sign_code(cfg) << (i * 4)))
}

/// The invariant value, observed identical on aarch64 native + wasm32 and
/// asserted here on whatever CI arch runs the suite (x86_64 on ubuntu/depot).
const EXACT_PREDICATE_FINGERPRINT: u64 = 302_063_904;

#[test]
fn orient3d_signs_are_platform_invariant() {
    assert_eq!(
        fingerprint(),
        EXACT_PREDICATE_FINGERPRINT,
        "exact-predicate sign fingerprint diverged on this target — the pure-Rust \
         CSG topology-determinism guarantee does not hold here. Signs (0=on,1=+,2=-): {:?}",
        configs().iter().map(sign_code).collect::<Vec<_>>()
    );
}

#[test]
fn exact_predicate_resolves_cases_float_cannot() {
    let cfgs = configs();
    // Coplanar / collinear-base must be EXACTLY zero (float dot-products rarely are).
    assert_eq!(sign_code(&cfgs[0]), 0, "coplanar unit quad must be exactly on-plane");
    assert_eq!(sign_code(&cfgs[5]), 0, "collinear base is coplanar with any apex");
    // A 1 nanometre flip at building scale must produce opposite, definite signs.
    let (above, below) = (sign_code(&cfgs[1]), sign_code(&cfgs[2]));
    assert_ne!(above, 0, "1 nm above the plane must be a definite side");
    assert_ne!(below, 0, "1 nm below the plane must be a definite side");
    assert_ne!(above, below, "±1 nm about the same plane must be opposite signs");
    // The near-coincident large-coordinate case (the Manifold collapse class)
    // must resolve to a definite sign, not a degenerate zero.
    assert_ne!(
        sign_code(&cfgs[3]),
        0,
        "near-coincident large-coord point must classify definitely (exact predicate)"
    );
    // Mirrored sub-mm tetra -> opposite signs.
    assert_ne!(sign_code(&cfgs[6]), sign_code(&cfgs[7]), "mirrored tetra must flip sign");
}
