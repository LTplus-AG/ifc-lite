// SPDX-License-Identifier: MPL-2.0

use super::super::flush::flush_band_at;
use super::extension::tri_touches_slab_footprint;
use super::frame::PrismFrame;
use super::kit::{dot, V2, V3};
use super::ptri::{ptris_from_mesh, PTri};
use crate::Mesh;

pub(super) type ExistingFloors = [Option<[usize; 2]>; 2];

struct PairedRectangle {
    depth: f64,
    floor: Option<[usize; 2]>,
}

/// Move the cap past a pair of proved coincident rectangular source faces.
/// Keep the existing floor when the finish ends inside the opening.
pub(super) fn adjust_paired_cap(pf: &mut PrismFrame, tris: &[PTri]) -> ExistingFloors {
    if pf.planes.len() != 2 {
        return [None; 2];
    }
    let mut floors = [None; 2];
    for (end, direction) in [(0, -1.0), (1, 1.0)] {
        if let Some(pair) = paired_rectangle(pf, tris, end, true, 5.0e-7) {
            pf.planes[end] = pair.depth + direction * 1.0e-9;
            floors[end] = pair.floor;
        }
    }
    floors
}

/// Exact subtraction can leave an authored interface cap alone when the
/// apparent jamb is a complete pair of coincident faces on touching solids.
pub(in crate::router::voids) fn paired_exact_jambs(
    host: &Mesh,
    [u, v, d]: [V3; 3],
    lo: V3,
    hi: V3,
    jamb: [bool; 2],
) -> [bool; 2] {
    let Some(tris) = ptris_from_mesh(host) else {
        return [false; 2];
    };
    // A right-angle placement is expressed with tiny sin/cos residuals.
    // Snap only exact-axis frames for the paired-face proof so a constant
    // source coordinate projects to the same depth at every corner.
    let cardinal = |axis: V3| {
        let principal = (0..3).find(|&k| (axis[k].abs() - 1.0).abs() <= 1.0e-14);
        if let Some(k) = principal.filter(|&k| (0..3).all(|j| j == k || axis[j].abs() <= 1.0e-14)) {
            let mut exact = [0.0; 3];
            exact[k] = axis[k].signum();
            exact
        } else {
            axis
        }
    };
    let [u, v, d] = [u, v, d].map(cardinal);
    let (lo2, hi2) = ([lo[0], lo[1]], [hi[0], hi[1]]);
    let pf = PrismFrame {
        u,
        v,
        d,
        planes: vec![lo[2], hi[2]],
        profiles: vec![vec![lo2, [hi2[0], lo2[1]], hi2, [lo2[0], hi2[1]]]],
        slab_area: vec![(hi2[0] - lo2[0]) * (hi2[1] - lo2[1])],
        slab_interior: vec![[(lo2[0] + hi2[0]) * 0.5, (lo2[1] + hi2[1]) * 0.5]],
        bb: (lo2, hi2),
    };
    let band = flush_band_at(pf.corner_mag());
    [0, 1].map(|end| jamb[end] && paired_rectangle(&pf, &tris, end, false, band).is_some())
}

fn paired_rectangle(
    pf: &PrismFrame,
    tris: &[PTri],
    end: usize,
    require_outside: bool,
    distance_limit: f64,
) -> Option<PairedRectangle> {
    let initial = pf.planes[end];
    let direction = if end == 0 { -1.0 } else { 1.0 };
    let mut target = None;
    let mut paired = [Vec::new(), Vec::new()];
    for (index, t) in tris.iter().enumerate() {
        let [x, y, z] = t.p.map(|point| dot(point, pf.d));
        let distance = x - initial;
        if x != y
            || y != z
            || distance.abs() > distance_limit
            || (require_outside && direction * distance <= 0.0)
        {
            continue;
        }
        if target.is_some_and(|value| value != x) {
            return None;
        }
        target = Some(x);
        let points = t.p.map(|point| pf.to2(point));
        let [a, b, c] = points;
        let area = 0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
        if area == 0.0 {
            return None;
        }
        paired[usize::from(area < 0.0)].push((index, points, area.abs()));
    }
    let target = target?;
    if paired.iter().any(|group| group.len() != 2) {
        return None;
    }
    let [Some(a), Some(b)] = paired.each_ref().map(|group| rectangle(group)) else {
        return None;
    };
    let profile = &pf.profiles[0];
    let bound_slack = if !require_outside {
        pf.corner_mag().max(1.0) * 4.0e-14
    } else {
        0.0
    };
    let contains = |outer: [V2; 2], point: V2| {
        (0..2)
            .all(|k| outer[0][k] - bound_slack <= point[k] && point[k] <= outer[1][k] + bound_slack)
    };
    let (outer, inner, floor) = if a == b {
        (a, None, None)
    } else if profile.len() == 4
        && profile
            .iter()
            .all(|p| (0..2).all(|k| p[k] == pf.bb.0[k] || p[k] == pf.bb.1[k]))
    {
        // Rectangle containment identifies the wider body even when both
        // source shells use inward winding and swap the signed-area groups.
        let (floor_side, outer, inner) = if b.iter().all(|&point| contains(a, point)) {
            (0, a, b)
        } else if a.iter().all(|&point| contains(b, point)) {
            (1, b, a)
        } else {
            return None;
        };
        if !(0..2).all(|k| inner[0][k] < pf.bb.1[k] && pf.bb.0[k] < inner[1][k])
            || (floor_side != end
                && !shell_extends_from_face(tris, pf, outer, inner, target, direction))
        {
            return None;
        }
        let floor = [paired[floor_side][0].0, paired[floor_side][1].0];
        (outer, Some(inner), Some(floor))
    } else {
        return None;
    };
    let [lo, hi] = outer;
    if !profile.iter().all(|&point| contains(outer, point)) {
        return None;
    }
    // Other surfaces within the rounding band can be an authored film or
    // a different nearby solid even when the actual cap movement misses them.
    let band = flush_band_at(pf.corner_mag());
    if tris.iter().enumerate().any(|(index, t)| {
        !paired.iter().flatten().any(|(i, ..)| *i == index)
            && !on_rectangle_boundary(t, pf, lo, hi)
            && !inner
                .is_some_and(|[inner_lo, inner_hi]| {
                    on_rectangle_boundary(t, pf, inner_lo, inner_hi)
                        && t.p
                            .iter()
                            .all(|&p| direction * (dot(p, pf.d) - target) <= 0.0)
                })
            && tri_touches_slab_footprint(t, pf, profile, target - band, target + band, 1.0e-8)
    }) {
        return None;
    }
    Some(PairedRectangle {
        depth: target,
        floor,
    })
}

/// A reversed area group could also mean the finish is the wider body.
/// Prove that the wider face has a side wall beyond the cap at a corner
/// belonging to that face alone.
fn shell_extends_from_face(
    tris: &[PTri],
    pf: &PrismFrame,
    wider: [V2; 2],
    narrower: [V2; 2],
    depth: f64,
    direction: f64,
) -> bool {
    let band = flush_band_at(pf.corner_mag());
    tris.iter().any(|tri| {
        on_rectangle_boundary(tri, pf, wider[0], wider[1])
            && tri.p.iter().any(|&p| {
                let xy = pf.to2(p);
                dot(p, pf.d) == depth
                    && (0..2).all(|k| xy[k] == wider[0][k] || xy[k] == wider[1][k])
                    && (0..2).any(|k| xy[k] < narrower[0][k] || xy[k] > narrower[1][k])
            })
            && tri.p.iter().any(|&p| direction * (dot(p, pf.d) - depth) > band)
    })
}

fn rectangle(faces: &[(usize, [V2; 3], f64)]) -> Option<[V2; 2]> {
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    let verts: Vec<_> = faces.iter().flat_map(|(_, p, _)| *p).collect();
    for p in &verts {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    if !verts
        .iter()
        .all(|p| (0..2).all(|k| p[k] == lo[k] || p[k] == hi[k]))
        || ![lo, hi, [lo[0], hi[1]], [hi[0], lo[1]]]
            .iter()
            .all(|p| verts.contains(p))
    {
        return None;
    }
    // The two triangles must share a diagonal. Sharing a perimeter
    // edge can meet the same corner and area checks while leaving a gap.
    let [(_, first, _), (_, second, _)] = faces else {
        return None;
    };
    let shared: Vec<_> = first
        .iter()
        .filter(|point| second.contains(point))
        .collect();
    let [a, b] = shared.as_slice() else {
        return None;
    };
    if a[0] == b[0] || a[1] == b[1] {
        return None;
    }
    let area = (hi[0] - lo[0]) * (hi[1] - lo[1]);
    let tally: f64 = faces.iter().map(|(_, _, area)| area).sum();
    (area > 0.0 && (tally - area).abs() <= 1.0e-12 * area).then_some([lo, hi])
}

/// Allow perimeter faces to touch an aperture that reaches the rectangle's
/// edge. A triangle projecting into the interior still vetoes the adjustment.
fn on_rectangle_boundary(triangle: &PTri, pf: &PrismFrame, lo: V2, hi: V2) -> bool {
    let projected = triangle.p.map(|p| pf.to2(p));
    (0..2).any(|axis| {
        [lo[axis], hi[axis]]
            .iter()
            .any(|edge| projected.iter().all(|p| p[axis] == *edge))
    })
}

/// When a cap meets an oblique source interface, f32 rounding makes its
/// vertices disagree in prism depth. Defer the cut only when the two sides
/// share all four source vertices and cover the aperture.
pub(super) fn has_oblique_paired_cap(pf: &PrismFrame, tris: &[PTri]) -> bool {
    if pf.planes.len() != 2 || pf.d.iter().filter(|value| value.abs() > 1.0e-14).count() < 2 {
        return false;
    }
    let band = flush_band_at(pf.corner_mag());
    let profile = &pf.profiles[0];
    pf.planes.iter().any(|&depth| {
        let mut sided = [Vec::new(), Vec::new()];
        for (index, tri) in tris.iter().enumerate() {
            if tri.p.iter().any(|&p| (dot(p, pf.d) - depth).abs() > band) {
                continue;
            }
            let [a, b, c] = tri.p.map(|p| pf.to2(p));
            let area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            if area.abs() <= band * band {
                continue;
            }
            let group = &mut sided[usize::from(area < 0.0)];
            if group.len() == 2 {
                return false;
            }
            group.push(index);
        }
        let [Some(first), Some(other)] = sided.each_ref().map(|side| quad_vertices(side, tris))
        else {
            return false;
        };
        if !first.iter().all(|point| other.contains(point)) {
            return false;
        }
        let projected = first.map(|point| pf.to2(point));
        let lo = std::array::from_fn::<_, 2, _>(|k| {
            projected.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min)
        });
        let hi = std::array::from_fn::<_, 2, _>(|k| {
            projected
                .iter()
                .map(|p| p[k])
                .fold(f64::NEG_INFINITY, f64::max)
        });
        let corners = [lo, [lo[0], hi[1]], [hi[0], lo[1]], hi];
        if (0..2).any(|k| hi[k] - lo[k] <= 2.0 * band)
            || !corners.iter().all(|corner| {
                projected
                    .iter()
                    .any(|p| (0..2).all(|k| (p[k] - corner[k]).abs() <= band))
            })
            || !profile
                .iter()
                .all(|p| (0..2).all(|k| lo[k] - band <= p[k] && p[k] <= hi[k] + band))
        {
            return false;
        }
        !tris.iter().enumerate().any(|(index, tri)| {
            !sided.iter().any(|side| side.contains(&index))
                && !(0..2).any(|k| {
                    [lo[k], hi[k]]
                        .iter()
                        .any(|edge| tri.p.iter().all(|&p| (pf.to2(p)[k] - edge).abs() <= band))
                })
                && tri_touches_slab_footprint(tri, pf, profile, depth - band, depth + band, 1.0e-8)
        })
    })
}

fn quad_vertices(side: &[usize], tris: &[PTri]) -> Option<[V3; 4]> {
    let [a, b] = *side else { return None };
    let [a, b] = [tris[a].p, tris[b].p];
    let mut vertices = a.to_vec();
    for point in b {
        if !vertices.contains(&point) {
            vertices.push(point);
        }
    }
    vertices.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_jamb_preserves_a_floor_wider_than_the_finish() {
        // The finish covers half of the aperture and meets the wider core at
        // depth zero. The exact route should retain the authored cap (#10528).
        let axes = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        for end in [0, 1] {
            let mut host = Mesh {
                positions: vec![
                    0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 3.0, 0.0, 0.0, 3.0, 0.0,
                    0.0, 0.0, 0.0, 1.5, 0.0, 0.0, 1.5, 3.0, 0.0, 0.0, 3.0, 0.0,
                ],
                indices: vec![0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6],
                ..Mesh::default()
            };
            if end == 1 {
                for triangle in host.indices.chunks_exact_mut(3) {
                    triangle.swap(1, 2);
                }
            }
            let depths = if end == 0 { [0.0, 0.012] } else { [-0.012, 0.0] };
            let jamb = [end == 0, end == 1];
            let lo = [1.0, 1.0, depths[0]];
            let hi = [2.0, 2.0, depths[1]];
            assert_eq!(paired_exact_jambs(&host, axes, lo, hi, jamb), jamb);
        }
    }

    #[test]
    fn exact_jamb_does_not_choose_a_wider_finish_as_the_floor_11276() {
        // The wide face is the bottom of the finish. Its exclusive corner
        // continues into the opening (+Z), while the narrower core lies below.
        let host = Mesh {
            positions: vec![
                0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 3.0, 0.0, 0.0, 3.0, 0.0,
                0.0, 0.0, 0.0, 1.5, 0.0, 0.0, 1.5, 3.0, 0.0, 0.0, 3.0, 0.0,
                4.0, 0.0, 0.012, 1.5, 0.0, -0.2,
            ],
            indices: vec![0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 1, 2, 8, 4, 9, 5],
            ..Mesh::default()
        };
        let axes = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let paired = paired_exact_jambs(&host, axes, [1.0, 1.0, 0.0], [2.0, 2.0, 0.012], [true, false]);
        assert_eq!(paired, [false, false]);
    }
}
