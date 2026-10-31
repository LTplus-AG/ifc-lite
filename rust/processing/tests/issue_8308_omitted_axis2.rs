// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #8308: an omitted `Axis2` of an `IfcCartesianTransformationOperator3D` is
//! IfcSecondProjAxis' constant +Y, projected. It is not `Axis3 × Axis1`, so
//! Axis1 = -X or Axis3 = -Z with no Axis2 is a MIRROR.
//!
//! The fixture maps one asymmetric L profile (area 0.28, profile centroid
//! (27/70, 13/70)) extruded 2 m, so a wrong frame moves the centroid even
//! though |det| = 1 keeps the volume. Expected centroids are hand-derived from
//! IfcBaseAxis in the fixture header; IfcOpenShell builds the same #100 frame
//! (`tests/evidence/m10/schema.json` -> `omittedAxis2`).

use ifc_lite_processing::{process, MeshData, ProcessingRequest, ProcessingResult};

fn run() -> ProcessingResult {
    let path = format!(
        "{}/tests/fixtures/issue_8308_omitted_axis2_mirror.ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    process(&bytes, &ProcessingRequest::default(), &mut ())
}

fn mesh(res: &ProcessingResult, id: u32) -> &MeshData {
    let mut meshes = res.meshes.iter().filter(|m| m.express_id == id);
    let mesh = meshes.next().unwrap_or_else(|| panic!("no mesh for #{id}"));
    assert!(meshes.next().is_none(), "#{id}: one mapped item, one mesh");
    mesh
}

/// Signed volume and volume centroid of the world mesh (`origin + position`).
/// The volume is positive only when the triangles wind outward.
fn moments(m: &MeshData) -> (f64, [f64; 3]) {
    let p = |i: u32| {
        let i = i as usize * 3;
        [0, 1, 2].map(|k| m.origin[k] + m.positions[i + k] as f64)
    };
    let (mut volume, mut first) = (0.0, [0.0; 3]);
    for t in m.indices.chunks_exact(3) {
        let [a, b, c] = [p(t[0]), p(t[1]), p(t[2])];
        let six_v = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
        volume += six_v / 6.0;
        for k in 0..3 {
            first[k] += six_v * (a[k] + b[k] + c[k]) / 24.0;
        }
    }
    (volume, first.map(|f| f / volume))
}

/// Stored per-vertex normals must point the way the triangles wind.
fn normals_follow_winding(m: &MeshData, id: u32) {
    let v = |i: u32, data: &[f32]| [0, 1, 2].map(|k| data[i as usize * 3 + k] as f64);
    for t in m.indices.chunks_exact(3) {
        let [a, b, c] = [v(t[0], &m.positions), v(t[1], &m.positions), v(t[2], &m.positions)];
        let (e1, e2) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let face = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        for &i in t {
            let n = v(i, &m.normals);
            assert!(n[0] * face[0] + n[1] * face[1] + n[2] * face[2] > 0.0, "#{id}: normal {n:?} against winding");
        }
    }
}

const TOL: f64 = 1e-5;

#[test]
fn omitted_axis2_uses_the_projected_plus_y_default() {
    let res = run();
    for (id, expected) in [
        // Axis1 = -X: IFC (and IfcOpenShell) mirror; Z x X rotated it to y = -13/70.
        (100u32, [-27. / 70., 13. / 70., 1.]),
        // The same frame with Axis2 = +Y authored: unchanged by the fix.
        (101, [-27. / 70., 13. / 70., 1.]),
        // Axis3 = -Z, default Axis1 = +X: a mirror in Z; Z x X gave y = -13/70.
        (102, [27. / 70., 13. / 70., -1.]),
        // Axis1 = +Y: +Y has no component left after projection, so Z x X
        // stands and the map is a quarter turn, not a mirror.
        (103, [-13. / 70., 27. / 70., 1.]),
    ] {
        let m = mesh(&res, id);
        let (volume, centroid) = moments(m);
        assert!((volume - 0.56).abs() < TOL, "#{id}: signed volume {volume}");
        for k in 0..3 {
            assert!(
                (centroid[k] - expected[k]).abs() < TOL,
                "#{id}: centroid {centroid:?}, expected {expected:?}"
            );
        }
        normals_follow_winding(m, id);
    }
}
