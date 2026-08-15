// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Axis-ray parity point-in-mesh test for enclosed-cavity classification.
//! Split from `cavities.rs` to keep it inside the module-size ratchet budget;
//! see that module's doc for the conservative-keep design.

/// Parity vote: cast the three axis-aligned rays from `point` (each with its
/// own sub-epsilon jitter to dodge edge/vertex grazing) against `tris` and
/// call the point enclosed when at least two rays report an odd crossing
/// count. A ray with any grazing hit is discarded; fewer than two clean rays
/// means "keep" (conservative).
pub(super) fn point_enclosed(point: [f64; 3], scale: f64, tris: &[[[f64; 3]; 3]]) -> bool {
    let dirs = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut valid = 0u32;
    let mut inside = 0u32;
    for (k, dir) in dirs.iter().enumerate() {
        // Distinct jitter per ray, orders of magnitude below feature size.
        let j = (k as f64 + 1.0) * 1e-7 * scale;
        let origin = [point[0] + j, point[1] + 1.3 * j, point[2] + 1.7 * j];
        match count_crossings(origin, *dir, scale, tris) {
            Some(n) => {
                valid += 1;
                if n % 2 == 1 {
                    inside += 1;
                }
            }
            None => continue, // grazing hit: discard this ray
        }
    }
    valid >= 2 && inside >= 2
}

/// Moller-Trumbore crossing count for one ray; `None` when any hit is too
/// close to a triangle edge/vertex or to the ray origin to trust.
fn count_crossings(
    origin: [f64; 3],
    dir: [f64; 3],
    scale: f64,
    tris: &[[[f64; 3]; 3]],
) -> Option<u32> {
    const BARY_EPS: f64 = 1e-9;
    let t_eps = 1e-9 * scale;
    let mut crossings = 0u32;
    for tri in tris {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let pv = [
            dir[1] * e2[2] - dir[2] * e2[1],
            dir[2] * e2[0] - dir[0] * e2[2],
            dir[0] * e2[1] - dir[1] * e2[0],
        ];
        let det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
        if det.abs() < 1e-16 {
            continue; // parallel: jittered siblings resolve true grazings
        }
        let inv = 1.0 / det;
        let tv = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
        let u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv;
        if u < -BARY_EPS || u > 1.0 + BARY_EPS {
            continue;
        }
        let qv = [
            tv[1] * e1[2] - tv[2] * e1[1],
            tv[2] * e1[0] - tv[0] * e1[2],
            tv[0] * e1[1] - tv[1] * e1[0],
        ];
        let v = (dir[0] * qv[0] + dir[1] * qv[1] + dir[2] * qv[2]) * inv;
        if v < -BARY_EPS || u + v > 1.0 + BARY_EPS {
            continue;
        }
        let t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv;
        if t <= -t_eps {
            continue; // behind the origin
        }
        if t < t_eps {
            return None; // origin on / grazing the surface
        }
        if u < BARY_EPS || v < BARY_EPS || u + v > 1.0 - BARY_EPS {
            return None; // edge/vertex hit: parity untrustworthy
        }
        crossings += 1;
    }
    Some(crossings)
}

#[cfg(test)]
mod tests {
    //! Direct unit tests of the `point_enclosed` vote, pinning the
    //! `valid >= 2 && inside >= 2` rule at its boundary rather than leaving
    //! it as incidental behaviour of whatever fixtures `cavities.rs`
    //! happens to send through. `simplify/mod.rs`'s cavity-drop tests only
    //! ever produce a unanimous 3-of-3 vote (deep interior sample points),
    //! so they pass unchanged under a 1-of-3 or 3-of-3 rule too and do not
    //! pin this threshold — verified by hand-editing the rule locally and
    //! re-running that suite before writing these.
    //!
    //! All three tests fix `point = [0, 0, 0]` and `scale = 1.0`, so the
    //! per-ray jitter origins are known exactly:
    //! ray0 (+X) origin = (1e-7, 1.3e-7, 1.7e-7)
    //! ray1 (+Y) origin = (2e-7, 2.6e-7, 3.4e-7)
    //! ray2 (+Z) origin = (3e-7, 3.9e-7, 5.1e-7)
    //! and `t_eps = 1e-9`. A "trap" triangle lies exactly on the plane
    //! matching one ray's own jittered coordinate on its axis, so that
    //! ray's Moller-Trumbore `t` comes out at (numerically) zero: a grazing
    //! hit, discarded. Because a trap triangle's normal is one of the other
    //! two axes, the other two rays run parallel to it (`det == 0`) and
    //! never see it at all — each trap affects exactly one ray.
    use super::point_enclosed;

    const POINT: [f64; 3] = [0.0, 0.0, 0.0];
    const SCALE: f64 = 1.0;

    /// Triangle on the plane x = ray0's jittered x-coordinate: grazes only
    /// the +X ray (t == 0), parallel to +Y and +Z (their directions lie in
    /// the x = const plane, so `det == 0` skips them).
    fn trap_x() -> [[f64; 3]; 3] {
        [[1e-7, -1.0, -1.0], [1e-7, 1.0, -1.0], [1e-7, 0.0, 1.0]]
    }

    /// Triangle on the plane y = ray1's jittered y-coordinate (1.3 * 2e-7):
    /// grazes only the +Y ray.
    fn trap_y() -> [[f64; 3]; 3] {
        [[-1.0, 2.6e-7, -1.0], [1.0, 2.6e-7, -1.0], [0.0, 2.6e-7, 1.0]]
    }

    /// Triangle on the plane z = ray2's jittered z-coordinate (1.7 * 3e-7):
    /// grazes only the +Z ray.
    fn trap_z() -> [[f64; 3]; 3] {
        [[-1.0, -1.0, 5.1e-7], [1.0, -1.0, 5.1e-7], [0.0, 1.0, 5.1e-7]]
    }

    /// Real, non-grazing crossing far down +X: gives ray0 an odd (inside)
    /// count. Its normal is X, so rays 1 and 2 (in-plane) never see it.
    fn far_hit_x() -> [[f64; 3]; 3] {
        [[10.0, -100.0, -100.0], [10.0, 100.0, -100.0], [10.0, 0.0, 100.0]]
    }

    /// Real, non-grazing crossing far down +Y: gives ray1 an odd (inside)
    /// count. Its normal is Y, so rays 0 and 2 never see it.
    fn far_hit_y() -> [[f64; 3]; 3] {
        [[-100.0, 10.0, -100.0], [100.0, 10.0, -100.0], [0.0, 10.0, 100.0]]
    }

    #[test]
    fn grazing_hit_on_every_axis_conservatively_keeps_the_point() {
        // All three rays graze their own trap triangle (t == 0 < t_eps) and
        // are discarded, so valid == 0. valid >= 2 fails regardless of
        // `inside`, so the point is NOT enclosed: conservative "keep".
        let tris = [trap_x(), trap_y(), trap_z()];
        assert!(
            !point_enclosed(POINT, SCALE, &tris),
            "a point straddling grazing hits on all three axes must be kept, never dropped"
        );
    }

    #[test]
    fn two_agreeing_valid_rays_mark_the_point_enclosed() {
        // Ray0 and ray1 both cross exactly once (odd -> inside) via a real
        // hit; ray2 grazes trap_z and is discarded. valid == 2, inside == 2:
        // the 2-of-3 majority is met and the point IS enclosed.
        let tris = [far_hit_x(), far_hit_y(), trap_z()];
        assert!(
            point_enclosed(POINT, SCALE, &tris),
            "two valid rays that agree on 'inside' must satisfy the majority vote"
        );
    }

    #[test]
    fn two_disagreeing_valid_rays_conservatively_keep_the_point() {
        // Ray0 crosses once (odd -> inside) via a real hit; ray1 sees no
        // geometry at all (zero crossings, even -> outside, but still a
        // valid/clean ray); ray2 grazes trap_z and is discarded. valid == 2
        // but inside == 1: the two valid rays disagree, so the vote must
        // NOT call it enclosed, even though two rays were clean.
        let tris = [far_hit_x(), trap_z()];
        assert!(
            !point_enclosed(POINT, SCALE, &tris),
            "two valid rays that disagree must not satisfy the majority vote"
        );
    }
}
