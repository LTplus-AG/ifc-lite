// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5698 on a real exporter file: the `860_solid_stratum` TIN (public corpus,
//! MGA94 Zone 56) stores its terrain points at Y ≈ 7,011,500 m, where one f32
//! ULP is 0.5 m. Narrowing those coordinates before the model RTC offset is
//! removed snapped every vertex to a 0.5 m grid; subtracting it in f64 first
//! keeps the surveyed points. The authored f64 coordinates are the oracle.

use ifc_lite_core::{AttributeValue, EntityDecoder};
use ifc_lite_processing::process_geometry;

const FIXTURE: &str = "../../tests/models/issues/860_solid_stratum.ifc";
/// The TIN's `IfcCartesianPointList3D`.
const POINT_LIST_ID: u32 = 31;

#[test]
fn issue_5698_national_grid_tin_keeps_surveyed_vertices() {
    let content = match std::fs::read(FIXTURE) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping #5698 real-model test: {FIXTURE} missing, run `pnpm fixtures`");
            return;
        }
        Err(e) => panic!("failed to read {FIXTURE}: {e}"),
    };
    let mut decoder = EntityDecoder::new(&content);
    let point_list = decoder.decode_by_id(POINT_LIST_ID).unwrap();
    let authored: Vec<[f64; 3]> =
        AttributeValue::parse_coordinate_list_3d_f64(point_list.get(0).unwrap().as_list().unwrap())
            .into_iter()
            .map(|(x, y, z)| [x, y, z])
            .collect();
    assert!(
        authored.len() > 100,
        "fixture changed: {} points",
        authored.len()
    );

    let result = process_geometry(&content);
    let rtc = result.frame.rtc_offset();
    let rtc = [rtc.0, rtc.1, rtc.2];
    assert!(
        rtc[1].abs() > 1_000_000.0,
        "the model must be rebased: {rtc:?}"
    );
    let vertices: Vec<[f64; 3]> = result
        .meshes
        .iter()
        .flat_map(|mesh| {
            mesh.positions
                .chunks_exact(3)
                .map(move |p| [0, 1, 2].map(|axis| p[axis] as f64 + mesh.origin[axis] + rtc[axis]))
        })
        .collect();
    assert!(!vertices.is_empty(), "the TIN must mesh");

    // f32 positions a few hundred metres from the RTC anchor round at the
    // 0.03 mm level; the pre-fix 0.5 m snapping was ~10,000 times that.
    const TOLERANCE_M: f64 = 1e-3;
    let distance = |a: &[f64; 3], b: &[f64; 3]| {
        (0..3)
            .map(|axis| (a[axis] - b[axis]).abs())
            .fold(0.0, f64::max)
    };
    let nearest = |from: &[f64; 3], to: &[[f64; 3]]| {
        to.iter()
            .map(|p| distance(from, p))
            .fold(f64::MAX, f64::min)
    };
    let worst_output = vertices
        .iter()
        .map(|v| nearest(v, &authored))
        .fold(0.0, f64::max);
    assert!(
        worst_output < TOLERANCE_M,
        "an output vertex is {worst_output} m from any authored point"
    );
    let worst_authored = authored
        .iter()
        .map(|p| nearest(p, &vertices))
        .fold(0.0, f64::max);
    assert!(
        worst_authored < TOLERANCE_M,
        "an authored point is {worst_authored} m from the mesh"
    );
}
