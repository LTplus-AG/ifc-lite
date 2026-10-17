// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geometry's `v3::canonical` against clash's, bit for bit (D21).
//!
//! The two are separate definitions on purpose: clash's feeds `detect_obb`,
//! which is TS-parity-locked, geometry's feeds `clash_solid`'s thickness gate,
//! which has no TS twin. Rather than promote a dependency for 14 lines, clash's
//! file is compiled into this test through `#[path]` (it is dependency-free by
//! design; `world_frame_fixture.rs` shares `world_frame_corpus.rs` the same
//! way, #5406). `#[path]` is test-only: in production it would break
//! `cargo publish`, because the packaged crate does not contain `../clash`.

use super::v3::canonical;
use super::v3_tests::Rng;

#[path = "../../../clash/src/canonical.rs"]
mod clash_canonical;

fn agree(n: [f64; 3]) {
    let (g, c) = (canonical(n), clash_canonical::canonical(n));
    for k in 0..3 {
        assert_eq!(g[k].to_bits(), c[k].to_bits(), "canonical({n:?}) slot {k}");
    }
}

#[test]
fn tie_cases_agree() {
    for s in [1.0, -1.0] {
        for t in [1.0, -1.0] {
            // |x| = |y|, |y| = |z|, |x| = |z|, and all equal, in every sign.
            agree([s, t, 0.0]);
            agree([0.0, s, t]);
            agree([s, 0.0, t]);
            agree([s, t, s]);
            agree([t, s, t]);
            agree([2.0 * s, 2.0 * t, 1.0]);
        }
    }
}

#[test]
fn signed_zero_and_non_finite_in_every_slot_agree() {
    let specials = [0.0, -0.0, 1.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY];
    for &x in &specials {
        for &y in &specials {
            for &z in &specials {
                agree([x, y, z]);
            }
        }
    }
}

#[test]
fn seeded_sweep_agrees() {
    let mut rng = Rng(0xFACE_FEED_0BAD_CAFE);
    for _ in 0..50_000 {
        agree(rng.v3());
    }
}
