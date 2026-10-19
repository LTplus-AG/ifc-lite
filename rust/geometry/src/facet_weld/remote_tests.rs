// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7633: an approximate plane bucket must not fit disconnected patches to
//! each other's f32 normal errors. Tests use actual finite source walls and
//! distinguish full-edge adjacency from a mere point contact.

use super::{snap_grid, weld_near_coplanar_facets};
use crate::Mesh;

type Point = [f64; 3];

fn triangles(tris: &[[Point; 3]]) -> Mesh {
    let mut mesh = Mesh::new();
    for tri in tris {
        for p in tri {
            mesh.indices.push(mesh.vertex_count() as u32);
            mesh.positions.extend(p.map(|v| v as f32));
            mesh.normals.extend([0., 0., 1.]);
        }
    }
    mesh
}

fn quad(p: [Point; 4], alternate: bool) -> [[Point; 3]; 2] {
    if alternate {
        [[p[0], p[1], p[3]], [p[1], p[2], p[3]]]
    } else {
        [[p[0], p[1], p[2]], [p[0], p[2], p[3]]]
    }
}

/// Close a finite front face into a prism. The extrusion points inward from
/// the front winding; every boundary edge then has opposite directed uses.
fn prism(front: [Point; 4], delta: Point, alternate: bool) -> Vec<[Point; 3]> {
    let back = front.map(|p| std::array::from_fn(|k| p[k] + delta[k]));
    let mut tris = Vec::from(quad(front, alternate));
    tris.extend(quad([back[3], back[2], back[1], back[0]], alternate));
    for i in 0..4 {
        let j = (i + 1) % 4;
        tris.extend(quad([front[i], back[i], back[j], front[j]], alternate));
    }
    tris
}

fn certified(mesh: &Mesh) -> bool {
    let mut seen = std::collections::BTreeMap::new();
    let mut positions = Vec::new();
    let mut ids = Vec::new();
    for p in mesh.positions.chunks_exact(3) {
        let point = [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])];
        let id = *seen.entry(point.map(super::dedup_key)).or_insert_with(|| {
            positions.push(point);
            positions.len() - 1
        });
        ids.push(id);
    }
    super::eligibility::source_is_conforming(mesh, &ids, &positions)
}

fn source_grid(mesh: &Mesh) -> Vec<f32> {
    mesh.positions
        .iter()
        .map(|&v| snap_grid(f64::from(v)) as f32)
        .collect()
}

/// These two wall segments came from the same authored plane, but their
/// independent f32 endpoints yield different normals. The old global fit
/// moves the remote corner by ~80 micrometres. Each finite patch is already
/// exactly planar and has no local facet jitter to correct.
#[test]
fn issue_7633_remote_planar_wall_patches_retain_source_corners() {
    let wall = |a: [f64; 2], b: [f64; 2]| {
        [
            [a[0], a[1], 3.65],
            [b[0], b[1], 3.65],
            [b[0], b[1], 3.9],
            [a[0], a[1], 3.9],
        ]
    };
    let a = wall(
        [17.515506744384766, 43.07204818725586],
        [17.441171646118164, 43.31073760986328],
    );
    let b = wall(
        [24.324649810791016, 21.207794189453125],
        [24.25031280517578, 21.44648551940918],
    );
    for alternate in [false, true] {
        for reverse in [false, true] {
            let mut tris = prism(a, [-0.1, 0., 0.], alternate);
            tris.extend(prism(b, [-0.1, 0., 0.], alternate));
            if reverse {
                tris.reverse();
            }
            let source = triangles(&tris);
            assert!(certified(&source), "positive must exercise partition");
            let result = weld_near_coplanar_facets(&source);
            assert_eq!(result.indices, source.indices);
            assert_eq!(
                result.positions,
                source_grid(&source),
                "a distant fitted normal must not move an already-planar patch"
            );
        }
    }
}

/// Two independent planes can meet at one corner and still share the coarse
/// normal/offset bucket. Joining their fits through that point would move a
/// different corner of the flat patch by two kernel grid steps.
#[test]
fn issue_7633_point_touching_patches_do_not_share_a_fit() {
    let g = 1. / 65536.;
    let a = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]];
    let b = [
        [0., 0., 0.],
        [-1., 0., 0.],
        [-1., -1., 4. * g],
        [0., -1., 4. * g],
    ];
    let mut tris = prism(a, [0., 0., 1.], false);
    tris.extend(prism(b, [0., 0., -1.], false));
    // The first face has the opposite shell orientation; reverse its prism.
    for tri in &mut tris[..12] {
        tri.swap(1, 2);
    }
    let source = triangles(&tris);
    assert!(
        certified(&source),
        "point-touch shells must remain eligible"
    );
    let result = weld_near_coplanar_facets(&source);
    assert_eq!(result.positions, source_grid(&source));
}

/// The original jitter-repair case must still fit: both endpoints of its
/// shared edge occupy the existing 100-micrometre canonical cells, even
/// though their input positions differ by 15 micrometres.
#[test]
fn issue_7633_connected_offset_jitter_still_joins_shared_edge() {
    let j = 15e-6;
    let source = triangles(&[
        [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
        [[1., 0., j], [1., 1., j], [0., 1., j]],
    ]);
    assert_ne!(&source.positions[3..6], &source.positions[9..12]);
    let result = weld_near_coplanar_facets(&source);
    assert_eq!(&result.positions[3..6], &result.positions[9..12]);
    assert_eq!(&result.positions[6..9], &result.positions[15..18]);
}

fn dual_domain_counts(mesh: &Mesh, key: impl Fn(f32) -> i64) -> (usize, usize) {
    let mut edges = std::collections::BTreeMap::<([i64; 3], [i64; 3]), [usize; 2]>::new();
    let mut collapsed = 0;
    for t in mesh.indices.chunks_exact(3) {
        let points: [[i64; 3]; 3] = std::array::from_fn(|corner| {
            std::array::from_fn(|k| key(mesh.positions[t[corner] as usize * 3 + k]))
        });
        let [a, b, c]: [[i64; 3]; 3] = points;
        let ab: [i128; 3] = std::array::from_fn(|k| i128::from(b[k]) - i128::from(a[k]));
        let ac: [i128; 3] = std::array::from_fn(|k| i128::from(c[k]) - i128::from(a[k]));
        collapsed += usize::from(
            [
                ab[1] * ac[2] - ab[2] * ac[1],
                ab[2] * ac[0] - ab[0] * ac[2],
                ab[0] * ac[1] - ab[1] * ac[0],
            ] == [0; 3],
        );
        for (a, b) in [(a, b), (b, c), (c, a)] {
            edges.entry((a.min(b), a.max(b))).or_default()[usize::from(a > b)] += 1;
        }
    }
    (
        edges.values().filter(|&&uses| uses != [1, 1]).count(),
        collapsed,
    )
}

#[test]
fn issue_7633_fine_closed_canonical_open_source_keeps_legacy_fit() {
    let lo = 49e-6;
    let faces = [
        [[lo, 0., 0.], [lo, 0., 1.], [lo, 1., 1.], [lo, 1., 0.]],
        [[1., 0., 0.], [1., 1., 0.], [1., 1., 1.], [1., 0., 1.]],
        [[lo, 0., 0.], [1., 0., 0.], [1., 0., 1.], [lo, 0., 1.]],
        [[lo, 1., 0.], [lo, 1., 1.], [1., 1., 1.], [1., 1., 0.]],
        [[lo, 0., 0.], [lo, 1., 0.], [1., 1., 0.], [1., 0., 0.]],
        [[lo, 0., 1.], [1., 0., 1.], [1., 1., 1.], [lo, 1., 1.]],
    ];
    let mut tris: Vec<_> = faces
        .into_iter()
        .flat_map(|face| quad(face, false))
        .collect();
    // Only this triangle copy changes. Both values occupy fine cell3, but
    // straddle the existing canonical-cell boundary at50 micrometres.
    tris[0][0][0] = 51e-6;
    let source = triangles(&tris);
    let fine = |v: f32| (f64::from(v) / crate::kernel::mesh_bridge::SNAP_GRID).round() as i64;
    let canonical = |v: f32| super::dedup_key(f64::from(v));
    assert_eq!(fine(49e-6_f32), fine(51e-6_f32));
    assert_ne!(canonical(49e-6_f32), canonical(51e-6_f32));
    assert_eq!(dual_domain_counts(&source, fine), (0, 0));
    assert_eq!(dual_domain_counts(&source, canonical), (4, 0));
    assert!(!certified(&source));

    let legacy_expected = source_grid(&source);
    assert_ne!(
        source.positions, legacy_expected,
        "declining partition must not silently return the untouched source"
    );
    let output = weld_near_coplanar_facets(&source);
    // The old global fit repairs this small canonical split. Compare actual
    // geometry, not just a Boolean gate result: returning raw or forcing the
    // new singleton partition both fail this invariant.
    assert_eq!(output.positions, legacy_expected);
    assert_eq!(output.indices, source.indices);
    assert_eq!(output.normals, source.normals);
    assert_eq!(dual_domain_counts(&output, fine), (0, 0));
    assert_eq!(dual_domain_counts(&output, canonical), (0, 0));
}

/// #7633: two singleton faces in an originally eligible cluster still receive
/// the established fit and grid write. Partition must not silently erase that
/// operation, even though the complete source consists of closed shells.
#[test]
fn issue_7633_unsupported_singleton_partition_keeps_legacy_grid_writes() {
    let tetra = |[a, b, c, d]: [Point; 4]| [[a, c, b], [a, b, d], [b, c, d], [c, a, d]];
    let mut tris = Vec::from(tetra([
        [0., 0., 0.],
        [1.1234567, 0., 0.],
        [0., 1.2345678, 0.],
        [0.2, 0.3, 1.345678],
    ]));
    let slope = 4. / 65536.;
    tris.extend(tetra([
        [3.1234567, 2.2345678, slope * 2.2345678],
        [4.345678, 2.2345678, slope * 2.2345678],
        [3.1234567, 3.456789, slope * 3.456789],
        [3.35, 2.55, 1.98765],
    ]));
    let source = triangles(&tris);
    assert!(certified(&source));
    let output = weld_near_coplanar_facets(&source);
    assert_eq!(output.indices, source.indices);
    assert_eq!(output.normals, source.normals);
    assert_ne!(
        output.positions, source.positions,
        "the legacy fit must still run"
    );
    for (before, after) in source
        .positions
        .chunks_exact(3)
        .zip(output.positions.chunks_exact(3))
    {
        if before[2] > 1. {
            assert_eq!(
                after, before,
                "unwelded apex cells retain the #4698 contract"
            );
        } else {
            let snapped = after
                .iter()
                .map(|&x| snap_grid(f64::from(x)) as f32)
                .collect::<Vec<_>>();
            assert_eq!(
                after, snapped,
                "the original supported cluster still writes the kernel grid"
            );
        }
    }
    assert!(
        source
            .positions
            .chunks_exact(3)
            .zip(output.positions.chunks_exact(3))
            .any(|(before, after)| before[2] == 0. && after[2] != 0.),
        "the original joint plane fit must still project the flat base"
    );
    assert!(certified(&output));
}

/// Two axis-sided prisms with one four-triangle top cluster, one bottom
/// cluster and six side clusters. This fixture inventory calls the existing
/// fit directly; it neither repeats the production bucket/DSU walk nor uses
/// the new eligibility decision to manufacture the expected geometry.
fn established_two_prism_fit(source: &Mesh) -> Mesh {
    use std::collections::BTreeMap;
    let mut seen = BTreeMap::new();
    let mut positions = Vec::new();
    let ids: Vec<_> = source
        .positions
        .chunks_exact(3)
        .map(|p| {
            let point = [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])];
            *seen.entry(point.map(super::dedup_key)).or_insert_with(|| {
                positions.push(point);
                positions.len() - 1
            })
        })
        .collect();
    let facets: Vec<_> = source
        .indices
        .chunks_exact(3)
        .map(|t| {
            let tri = [ids[t[0] as usize], ids[t[1] as usize], ids[t[2] as usize]];
            let [a, b, c] = tri.map(|id| positions[id]);
            let (normal, area2) = super::tri_normal(a, b, c).unwrap();
            super::fit::Facet {
                tri,
                normal,
                area2,
                offset: normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2],
            }
        })
        .collect();
    assert_eq!(facets.len(), 24);
    let mut moves = vec![Vec::new(); positions.len()];
    // Same deterministic normal-bucket order: Z, Y, X. Within each bucket
    // use the authored sign-aligned plane offsets (bottom before top).
    let groups: &[&[usize]] = &[
        &[2, 3, 14, 15],
        &[0, 1, 12, 13],
        &[8, 9, 20, 21],
        &[4, 5, 16, 17],
        &[10, 11],
        &[6, 7],
        &[22, 23],
        &[18, 19],
    ];
    for &members in groups {
        let reference = if members[0] < 4 {
            0
        } else if members[0] % 12 == 4 || members[0] % 12 == 8 {
            4
        } else {
            6
        };
        super::fit::project_component(
            &facets,
            members,
            facets[reference].normal,
            &positions,
            [0.; 3],
            &mut moves,
        );
    }
    let mut out = source.clone();
    for (dst, id) in out.positions.chunks_exact_mut(3).zip(ids) {
        let candidates = &moves[id];
        assert!(!candidates.is_empty());
        let mut sum = [0.; 3];
        for candidate in candidates {
            for k in 0..3 {
                sum[k] += candidate[k];
            }
        }
        let inverse = 1. / candidates.len() as f64;
        for k in 0..3 {
            dst[k] = snap_grid(sum[k] * inverse) as f32;
        }
    }
    out
}

fn two_supported_prisms(warp_first: bool) -> Mesh {
    let g = 1. / 65536.;
    let first = [
        [0., 0., 0.],
        [1., 0., 0.],
        [1., 1., if warp_first { 2. * g } else { 0. }],
        [0., 1., 0.],
    ];
    let slope = if warp_first { 0. } else { 4. * g };
    let second = [[3., 0., 0.], [4., 0., 0.], [4., 1., slope], [3., 1., slope]];
    let mut tris = prism(first, [0., 0., -1.], false);
    tris.extend(prism(second, [0., 0., -1.], false));
    triangles(&tris)
}

/// #7633: the coarse graph can be closed while actual fine-grid triangle
/// copies have a seam. Both proposed top patches have two triangles and are
/// planar; the fine-source guard must keep the established global fit.
#[test]
fn issue_7633_fine_open_canonical_closed_source_keeps_established_fit() {
    let clean = two_supported_prisms(false);
    assert!(certified(&clean));
    let established = established_two_prism_fit(&clean);
    assert_ne!(
        weld_near_coplanar_facets(&clean).positions,
        established.positions,
        "the supported planar split must be an observable positive control"
    );
    let mut source = clean.clone();
    // A late copy of front[0] already has its canonical representative from
    // triangle0. One fine step stays inside the same 100-micrometre cell.
    let corner = source.indices[11 * 3 + 2] as usize;
    assert_eq!(&source.positions[corner * 3..corner * 3 + 3], &[0., 0., 0.]);
    source.positions[corner * 3 + 2] = (1. / 65536.) as f32;
    let fine = |v: f32| (f64::from(v) / crate::kernel::mesh_bridge::SNAP_GRID).round() as i64;
    let canonical = |v: f32| super::dedup_key(f64::from(v));
    assert_eq!(dual_domain_counts(&source, fine), (4, 0));
    assert_eq!(dual_domain_counts(&source, canonical), (0, 0));
    let output = weld_near_coplanar_facets(&source);
    assert_eq!(output.positions, established.positions);
    assert_eq!(output.indices, source.indices);
    assert_eq!(output.normals, source.normals);
    assert!(!certified(&source));
}

/// #7633: complete source incidence and supported connected patches do not
/// authorize replacing the jitter fit of an internally nonplanar patch.
#[test]
fn issue_7633_nonplanar_supported_patch_keeps_established_fit() {
    let source = two_supported_prisms(true);
    assert!(certified(&source));
    let point = |i: usize| std::array::from_fn(|k| f64::from(source.positions[i * 3 + k]));
    assert_ne!(
        geometry_predicates::orient3d(point(0), point(1), point(2), point(5)),
        0.
    );
    let established = established_two_prism_fit(&source);
    assert_ne!(
        established.positions,
        source_grid(&source),
        "the old jitter fit must make an observable geometric correction"
    );
    let output = weld_near_coplanar_facets(&source);
    assert_eq!(output.positions, established.positions);
    assert_eq!(output.indices, source.indices);
    assert_eq!(output.normals, source.normals);
}
