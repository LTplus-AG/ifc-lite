// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::buf::Buf;
use crate::format::Limits;
use crate::geometry::{coordinate_info, SectionWriter};

/// The retained pass's meshes in emit order, and its frame metadata.
fn run(source: &[u8]) -> (Vec<CacheMesh>, Pass) {
    let mut meshes = Vec::new();
    let pass = run_retained(source, |mesh| {
        meshes.push(mesh);
        Ok(())
    })
    .unwrap();
    (meshes, pass)
}

/// `IfcSite` at (1000000, 2000000, 0), its x axis along world +Y (90° about
/// Z), holding one tetrahedron with local corners (0,0,0), (10,0,0), (0,1,0)
/// and (0,0,3), placed at the site origin.
const ROTATED_SITE: &[u8] = include_bytes!("../tests/fixtures/rotated_site_90.ifc");

/// Where a reader places a stored vertex: `yUp⁻¹(origin + position)` plus
/// `wasmRtcOffset`, all f64 (`(x, y, z)` Y-up is `(x, -z, y)` Z-up).
fn reader_world(mesh: &CacheMesh, at: usize, rtc: [f64; 3]) -> [f64; 3] {
    let p = &mesh.positions[at * 3..at * 3 + 3];
    let yup = [0, 1, 2].map(|a| mesh.origin[a] + f64::from(p[a]));
    [yup[0] + rtc[0], -yup[2] + rtc[1], yup[1] + rtc[2]]
}

#[test]
fn a_rotated_site_puts_each_local_corner_at_its_world_point() {
    let (meshes, pass) = run(ROTATED_SITE);
    let rtc = pass.coordinate_info.wasm_rtc_offset.expect("the site tier re-bases");
    assert_eq!(rtc, [1_000_000.0, 2_000_000.0, 0.0]);
    let mut world: Vec<[f64; 3]> = meshes
        .iter()
        .flat_map(|mesh| (0..mesh.positions.len() / 3).map(move |at| reader_world(mesh, at, rtc)))
        .collect();
    world.sort_by(|a, b| a.partial_cmp(b).unwrap());
    world.dedup();
    // R maps local x to world +Y and local y to world -X: local (10, 0, 0)
    // is (1000000, 2000010, 0), never the translation-only (1000010, 2000000, 0).
    assert_eq!(
        world,
        vec![
            [999_999.0, 2_000_000.0, 0.0],
            [1_000_000.0, 2_000_000.0, 0.0],
            [1_000_000.0, 2_000_000.0, 3.0],
            [1_000_000.0, 2_000_010.0, 0.0],
        ]
    );
    // Bounds follow the restored vertices: the section writer that sees the
    // meshes writes exactly this CoordinateInfo into the geometry head.
    let mut expected = pass.coordinate_info.clone();
    expected.original_bounds = [[-1.0, 0.0, -10.0], [0.0, 3.0, 0.0]];
    expected.shifted_bounds = expected.original_bounds;
    let mut expected_bytes = Buf::new();
    coordinate_info::write(&mut expected_bytes, &expected);
    let expected_bytes = expected_bytes.into_vec();
    let mut writer = SectionWriter::new(false, 0, Limits::FORMAT);
    let mut body = Vec::new();
    for mesh in &meshes {
        writer.push(mesh, &mut body).unwrap();
    }
    let head = writer.finish(pass.coordinate_info.clone(), &mut body).unwrap();
    // headLength u32, then meshCount, totalVertices, totalTriangles u32 each.
    assert_eq!(&head.bytes[16..16 + expected_bytes.len()], expected_bytes.as_slice(), "bounds follow the restored vertices");
}

#[test]
fn a_rotated_site_turns_each_normal_with_its_face() {
    let (meshes, _) = run(ROTATED_SITE);
    let mut faces = 0;
    for mesh in &meshes {
        let at = |i: u32| {
            let i = i as usize * 3;
            [0, 1, 2].map(|a| f64::from(mesh.positions[i + a]))
        };
        for tri in mesh.indices.chunks_exact(3) {
            let [a, b, c] = [at(tri[0]), at(tri[1]), at(tri[2])];
            let n = &mesh.normals[tri[0] as usize * 3..tri[0] as usize * 3 + 3];
            for edge in [[b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]] {
                let dot: f64 = (0..3).map(|k| f64::from(n[k]) * edge[k]).sum();
                assert!(dot.abs() < 1e-5, "normal {n:?} is not perpendicular to edge {edge:?}");
            }
            faces += 1;
        }
    }
    assert_eq!(faces, 4);
}

fn site(placement: [f64; 16]) -> MeshFrame {
    MeshFrame::select(Some(&placement), None)
}

/// Column-major placement at (1000000, 2000000, 0) whose x axis is `x_axis`.
fn placement(x_axis: [f64; 2]) -> [f64; 16] {
    [
        x_axis[0], x_axis[1], 0.0, 0.0, -x_axis[1], x_axis[0], 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1e6, 2e6, 0.0, 1.0,
    ]
}

fn mesh() -> MeshData {
    let mut row_major = [0.0; 16];
    for (i, v) in row_major.iter_mut().enumerate() {
        *v = i as f64 + 0.5;
    }
    MeshData::new(7, "IfcWall".into(), vec![10.0, 0.0, 0.0, 0.25, -3.5, 1.0], vec![0.0, 1.0, 0.0, 1.0, 0.0, 0.0], vec![0, 1, 0], [1.0; 4])
        .with_origin([4.0, 5.0, 6.0])
        .with_local_bounds(Some([0.0, 1.0, 2.0, 3.0, 4.0, 5.0]))
        .with_local_to_world(Some(row_major))
}

/// `to_cache_mesh` over [`mesh`], as both passes call it.
fn convert(rotation: Option<SiteRotation>) -> CacheMesh {
    let source = mesh();
    let arrays = (source.positions.clone(), source.normals.clone(), source.indices.clone());
    to_cache_mesh(&source, arrays, None, None, rotation)
}

#[test]
fn only_a_frame_that_removed_a_rotation_restores_one() {
    assert!(SiteRotation::removed_by(site(placement([0.0, 1.0]))).is_some());
    assert!(SiteRotation::removed_by(site(placement([1.0, 0.0]))).is_none(), "translation-only site");
    assert!(SiteRotation::removed_by(MeshFrame::ModelRtc { anchor: (1e6, 2e6, 0.0) }).is_none());
    assert!(SiteRotation::removed_by(MeshFrame::RawIfc).is_none());
}

#[test]
fn the_restore_rotates_points_and_directions_and_leaves_captured_transforms() {
    let frame = site(placement([0.0, 1.0]));
    let restored = convert(SiteRotation::removed_by(frame));
    let unrotated = convert(None);
    // R · (x, y, z) = (-y, x, z), then Y-up (x, z, -y).
    assert_eq!(restored.positions, vec![0.0, 0.0, -10.0, 3.5, 1.0, -0.25]);
    assert_eq!(restored.normals, vec![-1.0, 0.0, 0.0, 0.0, 0.0, -1.0]);
    assert_eq!(restored.origin, [-5.0, 6.0, -4.0]);
    // Every stored world point is the frame's own `to_world`, minus the RTC
    // the reader adds back from `wasmRtcOffset`.
    let source = mesh();
    for at in 0..2 {
        let local = [0, 1, 2].map(|a| source.origin[a] + f64::from(source.positions[at * 3 + a]));
        assert_eq!(reader_world(&restored, at, [1e6, 2e6, 0.0]), frame.to_world(local));
    }
    // Captured in IFC world axes before the bake: not rotated again.
    assert_eq!(restored.local_to_world, unrotated.local_to_world);
    assert_eq!(restored.local_bounds, unrotated.local_bounds);
}
