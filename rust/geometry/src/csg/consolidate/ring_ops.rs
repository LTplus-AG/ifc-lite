// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 2D ring cleanup used by `consolidate_coplanar` and by the cross-bucket
//! `conform` pass.
//!
//! Split out of `consolidate.rs` to keep it under the module-size ratchet.

/// Rim noise as a fraction of a ring's own size, `2⁻¹³`, used by
/// [`weld_near_coincident_2d`] before its absolute cap is applied.
const RIM_NOISE_OF_SIZE: f64 = 1.0 / 8192.0;

/// Physical ring-width noise limit, `2⁻¹²` metres. The legacy rim weld also
/// uses this numeric value as a cap in caller units; its behavior is unchanged.
const RIM_NOISE_CAP: f64 = 1.0 / 4096.0;

/// Merge consecutive near-coincident 2D contour vertices BEFORE the union/earcut.
///
/// The exact mesh-arrangement kernel correctly preserves two distinct rim points
/// that the modeller intended as one but f32 import / a shallow-dihedral LPI
/// crossing split a few µm apart (issue #1007 / schependomlaan: the diagonal
/// sliver "flap" over an opening). They reach `consolidate_coplanar` as a hairline
/// notch on the hole/outer ring; `simplify_2d_collinear` (a TURN-ANGLE test) does
/// not remove them, so earcut frames the notch out to a far vertex → a degenerate
/// needle (aspect ≫ 10⁵) that renders as a flap across the opening.
///
/// This collapses any vertex within `eps` of its kept predecessor onto that
/// predecessor. `eps` is a POWER OF TWO scaled to the ring's bounding-box extent
/// (`floor_pow2(extent) · 2⁻¹³` ≈ extent/8192) and CAPPED at an absolute
/// 2⁻¹² m (244 µm) — bit-deterministic. On the #1007 fixture the rim
/// duplicates span 6–72 µm on ~2 m faces (~3·10⁻⁶ … 4·10⁻⁵ of the extent)
/// while the smallest REAL feature edge is 0.2 m (~0.1 of the extent), so eps
/// (~10⁻⁴ of the extent) sits three orders of magnitude above the duplicate
/// spread and three below any real edge — no over-weld. The absolute cap is
/// what protects mm-scale features on LARGE rings: the duplicate spread comes
/// from f32 import noise / shallow-dihedral LPI crossings whose magnitude does
/// NOT grow with ring extent (operands are snapped about their AABB centre),
/// but an uncapped extent-relative eps reaches 1 mm at 8 m and would swallow a
/// genuine 1 mm chamfer on a long steel member. This runs in the already-
/// non-exact consolidation post-pass; it does NOT touch the exact kernel's
/// interner/predicates (no float weld in the determinism path).
pub(super) fn weld_near_coincident_2d(
    ring: &[nalgebra::Point2<f64>],
) -> Vec<nalgebra::Point2<f64>> {
    let n = ring.len();
    if n < 4 {
        return ring.to_vec();
    }
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in ring {
        minx = minx.min(p.x);
        miny = miny.min(p.y);
        maxx = maxx.max(p.x);
        maxy = maxy.max(p.y);
    }
    let extent = (maxx - minx).max(maxy - miny);
    if !extent.is_finite() || extent <= 0.0 {
        return ring.to_vec();
    }
    // extent · 2⁻¹³ rounded DOWN to a power of two, capped at an absolute
    // 2⁻¹² m so big rings can't swallow mm-scale features ⇒ exact, deterministic.
    let eps = (floor_pow2(extent) * RIM_NOISE_OF_SIZE).min(RIM_NOISE_CAP);
    let eps2 = eps * eps;
    let mut kept: Vec<nalgebra::Point2<f64>> = Vec::with_capacity(n);
    for &p in ring {
        let dup = kept.last().is_some_and(|q| {
            let dx = p.x - q.x;
            let dy = p.y - q.y;
            dx * dx + dy * dy < eps2
        });
        if !dup {
            kept.push(p);
        }
    }
    // close-the-loop check: last vs first.
    if kept.len() >= 2 {
        let (first, last) = (kept[0], *kept.last().unwrap());
        let dx = last.x - first.x;
        let dy = last.y - first.y;
        if dx * dx + dy * dy < eps2 {
            kept.pop();
        }
    }
    if kept.len() >= 3 {
        kept
    } else {
        ring.to_vec()
    }
}

/// Drop 2D contour vertices that are collinear with both neighbours. The
/// i_overlay union of many small fragments often leaves "phantom"
/// vertices on every fragment boundary that crosses the outer outline;
/// without this pass earcut would emit one sliver triangle per phantom.
pub(super) fn simplify_2d_collinear(ring: &[nalgebra::Point2<f64>]) -> Vec<nalgebra::Point2<f64>> {
    let n = ring.len();
    #[cfg(feature = "opening-perf-trace")]
    let mut work = crate::opening_perf_trace::RingSimplifierWork {
        input_vertices: n as u64,
        ..Default::default()
    };
    if n < 4 {
        #[cfg(feature = "opening-perf-trace")]
        work.record();
        return ring.to_vec();
    }
    let mut keep = vec![true; n];
    let mut changed = true;
    while changed {
        #[cfg(feature = "opening-perf-trace")]
        {
            work.sweeps = work.sweeps.saturating_add(1);
        }
        changed = false;
        for i in 0..n {
            if !keep[i] {
                continue;
            }
            #[cfg(feature = "opening-perf-trace")]
            {
                work.live_vertex_visits = work.live_vertex_visits.saturating_add(1);
            }
            // Each lazily generated candidate is exactly one find/keep probe.
            // Diagnostic accounting neither looks up extra candidates nor
            // changes the circular index order or the search predicate.
            let prev = (1..n)
                .map(|k| {
                    #[cfg(feature = "opening-perf-trace")]
                    {
                        work.prev_probes = work.prev_probes.saturating_add(1);
                        work.max_prev_probe_distance = work.max_prev_probe_distance.max(k as u64);
                    }
                    (i + n - k) % n
                })
                .find(|&k| keep[k]);
            let next = (1..n)
                .map(|k| {
                    #[cfg(feature = "opening-perf-trace")]
                    {
                        work.next_probes = work.next_probes.saturating_add(1);
                        work.max_next_probe_distance = work.max_next_probe_distance.max(k as u64);
                    }
                    (i + k) % n
                })
                .find(|&k| keep[k]);
            let (prev, next) = match (prev, next) {
                (Some(p), Some(n)) if p != i && n != i && p != n => (p, n),
                _ => continue,
            };
            let a = ring[prev];
            let b = ring[i];
            let c = ring[next];
            let e1x = b.x - a.x;
            let e1y = b.y - a.y;
            let e2x = c.x - b.x;
            let e2y = c.y - b.y;
            let cross = e1x * e2y - e1y * e2x;
            let len1 = (e1x * e1x + e1y * e1y).sqrt();
            let len2 = (e2x * e2x + e2y * e2y).sqrt();
            let denom = len1 * len2;
            // 1e-4 = sin(0.006°). Real arc samples sit well above this
            // (cavity 6-seg per quadrant ⇒ 15°/segment ⇒ sin ≈ 0.26); the
            // i_overlay union of split fragments leaves "phantom" vertices
            // whose sin(angle) ranges 1e-7..1e-5, all caught here.
            if denom < 1.0e-18 || (cross.abs() / denom) < 1.0e-4 {
                keep[i] = false;
                changed = true;
                #[cfg(feature = "opening-perf-trace")]
                {
                    work.removals = work.removals.saturating_add(1);
                }
            }
        }
    }
    #[cfg(feature = "opening-perf-trace")]
    work.record();
    ring.iter()
        .zip(keep.iter())
        .filter_map(|(p, k)| if *k { Some(*p) } else { None })
        .collect()
}

/// One i_overlay union ring, cleaned for triangulation: rim duplicates welded
/// (the #1007 diagonal-sliver source) BEFORE collinear phantoms are dropped, then
/// `None` if what is left is noise ([`ring_is_noise`]).
pub(super) fn clean_ring(
    ring: &[[f64; 2]],
    plane_area: f64,
    length_unit_scale: f64,
) -> Option<Vec<nalgebra::Point2<f64>>> {
    let pts: Vec<_> = ring.iter().map(|p| nalgebra::Point2::new(p[0], p[1])).collect();
    let simplified = simplify_2d_collinear(&weld_near_coincident_2d(&pts));
    (!ring_is_noise(&simplified, plane_area, length_unit_scale)).then_some(simplified)
}

/// Is a simplified 2D ring noise? `plane_area` is the summed area of the plane
/// bucket it came from. `length_unit_scale` is metres per caller unit; only the
/// new width comparison is normalized, not the pre-existing absolute area floor
/// or rim weld.
///
/// Noise is a ring under [`NOISE_AREA`], or one whose mean width
/// `2·area / perimeter` is under [`RIM_NOISE_CAP`] metres and whose area is
/// under [`NOISE_PLANE_SHARE`] of its plane. Multiplying area by metres per
/// caller unit puts that width comparison in metres without changing the
/// pre-existing caller-unit tests.
///
/// The width gate is what keeps a real opening on a large face, which the plane
/// share alone filled (#4698). The share gate is what keeps a hairline ring that
/// is most of its plane, such as a µm-deep reveal lip. Fewer than three vertices
/// is noise.
///
pub(super) fn ring_is_noise(
    ring: &[nalgebra::Point2<f64>],
    plane_area: f64,
    length_unit_scale: f64,
) -> bool {
    let n = ring.len();
    if n < 3 {
        return true;
    }
    let edges = || (0..n).map(|i| (ring[i], ring[(i + 1) % n]));
    let twice_signed_area: f64 = edges().map(|(a, b)| a.x * b.y - b.x * a.y).sum();
    let area = (twice_signed_area * 0.5).abs();
    if area < NOISE_AREA {
        return true;
    }
    if !(area < plane_area * NOISE_PLANE_SHARE) {
        return false;
    }
    let perimeter: f64 = edges().map(|(a, b)| (b - a).norm()).sum();
    2.0 * area * length_unit_scale < perimeter * RIM_NOISE_CAP
}

/// Absolute area floor for [`ring_is_noise`], in squared mesh units. Inherited
/// from origin/main and still caller-unit-based. The physical width/share gate
/// also catches small compact rings that occupy only a tiny share of their
/// plane; the legacy floor can still differ by unit when that share gate is
/// deliberately bypassed.
const NOISE_AREA: f64 = 1.0e-8;

/// Share of its plane under which a thin ring counts as noise ([`ring_is_noise`]).
const NOISE_PLANE_SHARE: f64 = 1.0e-4;

pub(super) fn floor_pow2(x: f64) -> f64 {
    if !x.is_finite() || x <= 0.0 {
        return 0.0;
    }
    // 2^floor(log2(x)) via the unbiased exponent of the f64 representation.
    let exp = x.to_bits() >> 52 & 0x7ff; // biased exponent
    let unbiased = exp as i64 - 1023;
    // f64::powi keeps a power-of-two base exact; 2.0_f64.powi is exact for the
    // representable exponent range we hit (|coords| ≲ 1e7 ⇒ exponent ≲ 24).
    2.0_f64.powi(unbiased as i32)
}

#[cfg(test)]
#[path = "ring_ops_tests.rs"]
mod tests;
