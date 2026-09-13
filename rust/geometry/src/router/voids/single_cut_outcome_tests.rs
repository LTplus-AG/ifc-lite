// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4692: the sequential void loop took "did the single-cutter subtract cut
//! the host" from the result's triangle count and a 0.1 % volume test, not
//! from the kernel.

use super::*;
use crate::mesh::Mesh;

/// A vertical triangular prism over `(x, y)` corners, from `z0` to `z1`,
/// wound outward.
fn triangular_prism(corners: [(f32, f32); 3], z0: f32, z1: f32) -> Mesh {
    let mut m = Mesh::new();
    let n = [0.0, 0.0, 1.0];
    for &(x, y) in &corners {
        m.positions.extend_from_slice(&[x, y, z0]);
        m.normals.extend_from_slice(&n);
    }
    for &(x, y) in &corners {
        m.positions.extend_from_slice(&[x, y, z1]);
        m.normals.extend_from_slice(&n);
    }
    // Corners are counter-clockwise seen from +Z: bottom reversed, top as is.
    m.indices.extend_from_slice(&[0, 2, 1, 3, 4, 5]);
    for i in 0..3u32 {
        let j = (i + 1) % 3;
        m.indices.extend_from_slice(&[i, j, 3 + j, i, 3 + j, 3 + i]);
    }
    m
}

/// What the mitre removes, bounded loosely around 1/512 m³ and well under
/// the 0.1 % band (0.004 m³). The #635 box fallback removes the wedge's whole
/// x extent through the wall, 0.0078 m³, and pulls the +X edge in from 8.
fn removed_is_the_mitre(removed: f64) -> bool {
    (0.0015..0.003).contains(&removed)
}

/// An 8 x 0.25 x 2 m wall mitred at its +X end by a wedge that removes
/// 1/512 m³ of 4 m³ (0.05 %; the kernel's f32 output lands at about 0.057 %).
/// The mitred wall is still six planar quads, so the kernel's cut has the
/// host's triangle count, and the volume it removed is under the 0.1 % noise
/// band. On origin/main the loop read that real cut as "no change", threw it
/// away, and the fallback's engulf guard then left the wall un-cut.
#[test]
fn a_same_count_cut_under_the_volume_band_is_kept_4692() {
    let host =
        GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(8.0, 0.25, 2.0));
    // The mitre runs from (8, 0) to (8 - 1/128, 0.25), extended past both faces.
    let wedge = triangular_prism(
        [(8.007_812_5, -0.25), (8.5, 0.5), (7.984_375, 0.5)],
        -1.0,
        3.0,
    );
    let (mn, mx) = wedge.bounds();
    let (mn, mx) = (
        Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
    );

    // Premise, on the kernel alone: the cut keeps the count and moves the
    // volume by under 0.1 %.
    let GroupCut::Cut(direct) = ClippingProcessor::new().subtract_mesh(&host, &wedge) else {
        panic!("premise: the kernel cuts the mitre");
    };
    assert_eq!(
        direct.triangle_count(),
        host.triangle_count(),
        "premise: same triangle count"
    );
    let removed = mesh_signed_volume(&host).abs() - mesh_signed_volume(&direct).abs();
    assert!(
        removed_is_the_mitre(removed),
        "premise: the wedge removes about 1/512 m³, got {removed}"
    );

    let openings = vec![OpeningType::NonRectangular(
        wedge,
        mn,
        mx,
        Some(Vector3::new(0.0, 0.0, 1.0)),
    )];
    let ctx = VoidContext {
        merged_openings: openings.clone(),
        openings,
        param: None,
        bool2d: None,
    };
    let router = GeometryRouter::new();
    let bounds = world_host_bounds(&host);
    let out = router.apply_void_context_inner(host.clone(), &ctx, 7, bounds, false);

    let removed = mesh_signed_volume(&host).abs() - mesh_signed_volume(&out).abs();
    let (_, hi) = out.bounds();
    assert!(
        removed_is_the_mitre(removed) && hi.x == 8.0,
        "the mitre must be the wedge the kernel cut (about 1/512 m³ removed, +X edge still at 8), \
         got {removed} m³ removed and max x {}",
        hi.x
    );
}
