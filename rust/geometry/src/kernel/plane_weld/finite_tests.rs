// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::kernel::arrangement::difference_all_lenient_with_conformity;
use crate::kernel::mesh_bridge::tris_to_mesh;
use crate::kernel::plane_weld::promote_subtract_cutter_onto_host_faces;
use std::collections::BTreeMap;

fn counts(tris: &[Tri]) -> (usize, usize, usize) {
    let mesh = tris_to_mesh(tris);
    let mut uses = BTreeMap::<([i64; 3], [i64; 3]), [usize; 2]>::new();
    let q = |i: u32| -> [i64; 3] {
        std::array::from_fn(|k| (mesh.positions[i as usize * 3 + k] as f64 * 65536.).round() as i64)
    };
    let mut collapsed = 0;
    for t in mesh.indices.chunks_exact(3) {
        let p = [q(t[0]), q(t[1]), q(t[2])];
        let a: [i128; 3] = std::array::from_fn(|k| (p[1][k] - p[0][k]) as i128);
        let b: [i128; 3] = std::array::from_fn(|k| (p[2][k] - p[0][k]) as i128);
        collapsed += usize::from(
            [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ] == [0; 3],
        );
        for i in 0..3 {
            let (a, b) = (p[i], p[(i + 1) % 3]);
            if a != b {
                uses.entry((a.min(b), a.max(b))).or_default()[usize::from(a > b)] += 1;
            }
        }
    }
    (
        tris.len(),
        uses.values().filter(|n| **n != [1, 1]).count(),
        collapsed,
    )
}

/// #7635 candidate reduction: a closed slab with two four-corner holes.
/// One hole is the cutter footprint; another short wall supplies the remote
/// plane. No source-cap deficit or consolidation is involved.
#[test]
fn issue_7635_extended_cutter_arris_preserves_closed_hole() {
    use crate::kernel::mesh_bridge::{mesh_to_tris, orient_outward};
    use crate::{extrude_profile, Point2, Profile2D};
    let points = |p: &[[f64; 2]]| p.iter().map(|p| Point2::new(p[0], p[1])).collect();
    let mut profile = Profile2D::new(points(&[[20., 15.], [30., 15.], [30., 25.], [20., 25.]]));
    profile.add_hole(points(&[
        [23.48651123046875, 21.2086181640625],
        [23.560836791992188, 20.969924926757812],
        [24.324661254882812, 21.207794189453125],
        [24.250320434570312, 21.446487426757812],
    ]));
    let (a, b) = (
        [24.898880004882812, 16.673446655273438],
        [25.077285766601562, 16.1005859375],
    );
    profile.add_hole(points(&[
        a,
        b,
        [b[0] + 0.4, b[1] + 0.125],
        [a[0] + 0.4, a[1] + 0.125],
    ]));
    let mut host = extrude_profile(&profile, 0.25, None).unwrap();
    for p in host.positions.chunks_exact_mut(3) {
        p[2] = (p[2] as f64 + 3.649993896484375) as f32;
    }
    let h = orient_outward(mesh_to_tris(&host));
    let c = opening_cutter();
    assert_eq!(counts(&h), (52, 0, 0), "reduced host must be closed");
    assert_eq!(counts(&c), (12, 0, 0), "cutter must be closed");
    // Measure retained kernel geometry before f32 storage and the second snap
    // performed by mesh_volume; topology below still validates stored f32.
    let volume = crate::kernel::signed_volume::signed_volume_of;
    let uncut_volume = volume(&h);
    assert!(uncut_volume > 0.0);
    // Reordering either operand cannot change which copies of a cutter corner
    // retain the finite incidence. Rotate triangles without reversing winding.
    for reverse in [false, true] {
        let (mut h, mut c) = (h.clone(), c.clone());
        if reverse {
            h.reverse();
            c.reverse();
            for t in h.iter_mut().chain(c.iter_mut()) {
                t.rotate_left(1);
            }
        }
        let mut welded = c.clone();
        let moved = promote_subtract_cutter_onto_host_faces(&mut welded, &h);
        assert_eq!(moved, 0, "all original cutter occurrences must stay fixed");
        assert_eq!(welded, c, "cutter copies must agree exactly");
        let (current, changed, conforming) = difference_all_lenient_with_conformity(&h, &[&welded]);
        let (unmoved, changed_unmoved, conforming_unmoved) =
            difference_all_lenient_with_conformity(&h, &[&c]);
        assert!(
            !changed && conforming,
            "redundant cut must remain conforming"
        );
        assert!(!changed_unmoved && conforming_unmoved);
        assert_eq!((counts(&unmoved).1, counts(&unmoved).2), (0, 0));
        assert_eq!(
            (counts(&current).1, counts(&current).2),
            (0, 0),
            "#7635 a redundant opening must preserve the slab boundary"
        );
        assert!(
            (volume(&current) - uncut_volume).abs() <= 1e-10 * uncut_volume,
            "closed output must retain the uncut slab volume"
        );
        // The exported Mesh volume reader snaps once more. Bound that reading
        // with the same coordinate-quantization budget as the shared producer
        // regression, while the raw-kernel volume above remains tightly fixed.
        let exported_volume = |t: &[Tri]| crate::kernel::mesh_volume::mesh_volume(&tris_to_mesh(t));
        let area = |t: &[Tri]| {
            t.iter()
                .map(|p| {
                    let p = p.map(|v| crate::Vector3::new(v[0], v[1], v[2]));
                    (p[1] - p[0]).cross(&(p[2] - p[0])).norm() * 0.5
                })
                .sum::<f64>()
        };
        let magnitude = h
            .iter()
            .chain(current.iter())
            .flatten()
            .flatten()
            .fold(0.0_f64, |m, v| m.max(v.abs()));
        let displacement =
            3.0_f64.sqrt() * (2.0 / 65536.0 + 2.0 * f64::from(f32::EPSILON) * magnitude);
        let mesh_delta = (exported_volume(&current) - exported_volume(&h)).abs();
        let bound = (area(&h) + area(&current)) * displacement;
        eprintln!("#7635 reverse={reverse}: raw_volume_delta={} stored_grid_volume_delta={mesh_delta} quantization_bound={bound}",
            (volume(&current) - uncut_volume).abs());
        assert!(
            mesh_delta <= bound,
            "stored mesh must retain quantized volume"
        );
    }
}

// Exact pre-weld cutter, not a decimal-rounded approximation.
fn opening_cutter() -> Vec<Tri> {
    let p = [
        [23.560836791992188, 20.969924926757812, 3.5749969482421875],
        [24.250320434570312, 21.446487426757812, 3.5749969482421875],
        [24.324661254882812, 21.207794189453125, 3.5749969482421875],
        [23.48651123046875, 21.2086181640625, 3.5749969482421875],
        [23.560836791992188, 20.969924926757812, 3.975006103515625],
        [24.324661254882812, 21.207794189453125, 3.9749908447265625],
        [24.250320434570312, 21.446487426757812, 3.975006103515625],
        [23.48651123046875, 21.2086181640625, 3.9749908447265625],
    ];
    let triangles = [
        [0, 1, 2],
        [1, 0, 3],
        [4, 5, 6],
        [6, 7, 4],
        [1, 3, 7],
        [1, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
        [0, 2, 5],
        [0, 5, 4],
        [2, 1, 6],
        [2, 6, 5],
    ];
    triangles.into_iter().map(|t| t.map(|i| p[i])).collect()
}

/// #7635 requires finite containment, not just an exact common line.
#[test]
fn issue_7635_arris_certificate_requires_finite_manifold_edges() {
    let (a, b) = ([0., 0., 0.], [0., 0., 1.]);
    let corner = [[a, [1., 0., 0.], b], [a, b, [0., 1., 0.]]];
    assert!(Edges::new(corner.iter()).is_arris(&a, &b));
    assert!(!Edges::new(corner[..1].iter()).is_arris(&a, &b));
    let coplanar = [corner[0], [a, b, [-1., 0., 0.]]];
    assert!(!Edges::new(coplanar.iter()).is_arris(&a, &b));
    let same_direction = [corner[0], [b, a, [0., 1., 0.]]];
    assert!(!Edges::new(same_direction.iter()).is_arris(&a, &b));
    let nonmanifold = [corner[0], corner[1], [a, b, [0., -1., 0.]]];
    assert!(!Edges::new(nonmanifold.iter()).is_arris(&a, &b));
    let cutter = crate::kernel::arrangement::box_mesh([0., 0., -1.], [1., 1., 2.]);
    let edges = CutterEdges::new(&cutter);
    assert!(edges.contains(&[0., 0., 2.], &a, &b, &corner[0]));
    assert!(!edges.contains(&[0., 0., 2.], &a, &[0., 0., 3.], &corner[0]));
    assert!(!edges.contains(&[0., 0., 2.], &a, &[f64::EPSILON, 0., 1.], &corner[0]));
}

/// A finite incidence may justify protection even when the remote plane's
/// far endpoint leaves the source plane's band. It cannot certify a cutter
/// edge that stops short of the host arris.
#[test]
fn issue_7635_finite_certificate_is_distinct_from_mutual_plane_coincidence() {
    use crate::kernel::plane_weld::{incidence::Guard, Face, NearBand};
    let g = 1. / 65536.;
    let host = [
        [[0., 0., 0.], [1., 0., 0.], [0., 0., 1.]],
        [[0., 0., 0.], [0., 0., 1.], [0., 1., 0.]],
        [[3., 4. * g, 0.], [30., 31. * g, 0.], [3., 4. * g, 1.]],
    ];
    let mut band = NearBand::default();
    band.observe_tris(&host);
    let faces: Vec<_> = host.iter().map(|t| Face::new(t, &band).unwrap()).collect();
    let (v, w) = ([0., 0., 2.], [0., g, 2.]);
    let mut guard = Guard::new(&faces);
    assert!(!guard.refuses(&w, 2, &[0, 1]));
    let cutter = crate::kernel::arrangement::box_mesh([0., 0., -1.], [1., 1., 2.]);
    assert!(guard.refuses_finite(&v, &w, 2, &[0, 1], &CutterEdges::new(&cutter)));
    let mut crossing = cutter.clone();
    for p in crossing.iter_mut().flatten() {
        let (x, y) = (p[0], p[1]);
        p[0] = x - y;
        p[1] = x + y;
    }
    assert!(
        !guard.refuses_finite(&v, &w, 2, &[0, 1], &CutterEdges::new(&crossing)),
        "a shared arris with crossing angular sectors is not an existing wall"
    );
    let short = crate::kernel::arrangement::box_mesh([0., 0., 0.5], [1., 1., 2.]);
    assert!(!guard.refuses_finite(&v, &w, 2, &[0, 1], &CutterEdges::new(&short)));
}
